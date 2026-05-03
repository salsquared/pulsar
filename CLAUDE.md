# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Hono dev server on **port 4103** with tsx watch mode. Loads `.env.development` (`DATABASE_URL=file:./prisma/dev.db`).
- `npm run start` — production server on **port 3103**. Loads `.env.production` (`DATABASE_URL=file:./prisma/prod.db`).
- `npm run build` — compiles TypeScript to `dist/`.
- `npm run lint` — ESLint + TypeScript type-check.
- `npx prisma migrate dev` / `npx prisma generate` — schema at `prisma/schema.prisma` (SQLite). Dev and prod use **separate DB files** (`prisma/dev.db` vs `prisma/prod.db`).
- `npx tsx src/index.ts` — run entry point directly without building (useful during early development).

One-off scripts (fetcher experiments, DB inspection, backfill tests) belong in `scripts/` as kebab-case `.ts` files run with `npx tsx`. Do not put experiments in the repo root.

## Documentation

All diagrams in `docs/` must use Mermaid fenced code blocks (` ```mermaid `). Do not use ASCII art for diagrams. In Mermaid node labels, use `<br/>` for line breaks — do not use `\n`, as the renderer does not respect it.

Node.js LTS (v24.x) is required.

## Architecture

Full architecture rationale lives in `docs/architecture.md`. What follows is operational context for working in the codebase.

### Role in the salsquared ecosystem

Pulsar is a **backend-only service** (no UI) that owns all financial data: it fetches from external APIs on a schedule, normalizes everything into a common OHLCV schema, stores it locally, and exposes a REST API. Mission Control and other consumers query Pulsar instead of hitting CoinGecko/Yahoo/FRED directly. Pulsar runs behind Cloudflare Tunnel at port 3103; there is intentionally no auth layer since it is internal-only.

### Ingest pipeline: PM2 cron_restart → source registry → pipeline → DB

Scheduling is done entirely by PM2 via `cron_restart` in `ecosystem.config.cjs` — there is no in-process scheduler and no `node-cron` dependency. Each ingest source is a separate short-lived PM2 process entry. PM2 sets `SOURCE_ID` in the env and restarts the process on the cron schedule. `src/ingest/run.ts` is the shared entry point: it reads `SOURCE_ID` (and optionally `STARTUP_DELAY_SECONDS` to stagger boot bursts), calls `pipeline.ts:runIngest(sourceId)`, and exits. `autorestart: false` on all ingest entries ensures PM2 does not restart on normal exit.

`pipeline.ts:runIngest(sourceId)`:

1. Calls `source.fetch()` to get raw data
2. Normalizes into `NormalizedTick[]` (the common output shape all fetchers must produce — see `src/types.ts`)
3. Batch-inserts via `prisma.priceTick.createMany({ skipDuplicates: true })` — the `@@unique([assetId, timestamp, source])` constraint handles deduplication
4. POSTs the inserted ticks to `/internal/notify` so the API server can fan them out over WebSocket
5. Writes an `IngestJob` row with status and row count

**Scheduled jobs are incremental-only.** PM2's `cron_restart` will SIGKILL a still-running process when the next cron fires, so long-running backfills must never run inside an ingest entry. Backfills go through the on-demand path in `src/routes/history.ts` (`pipeline.backfill()`), through `POST /ingest/:sourceId`, or as a one-off `scripts/` invocation — all of which run outside the cron-driven jobs.

**To add a new data source:** add a `SourceConfig` entry to `src/lib/source-registry.ts` and a corresponding PM2 entry in `ecosystem.config.cjs` (`SOURCE_ID` env + `cron_restart`). No pipeline changes needed.

### On-demand historical backfill

When `/history/:id` receives a `from` date older than what's in the DB, `src/routes/history.ts` calls `pipeline.ts:backfill(assetId, from, to)` before returning. Backfill detects the coverage gap, fetches the missing range from the source, and inserts. Long-range history (years) is served from the local DB; only gaps trigger external API calls.

### Caching

`src/lib/cache.ts` is a direct port of Mission Control's `withCache` wrapper. Cache key = `pathname + sorted query params`. On handler error it returns the last good payload with `X-Cache: STALE-FALLBACK` and a 60s retry TTL. Every route that hits the DB or an external API should be wrapped in `withCache` — uncached handlers are the exception.

### Database

`src/lib/prisma.ts` exports a singleton `PrismaClient` cached on `globalThis` to survive tsx watch restarts. **WAL mode is mandatory** — multiple PM2 processes (API + every ingest job + rollup) write to the same SQLite file, and the default rollback-journal mode would error with `SQLITE_BUSY`. The Prisma module runs `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`, and `PRAGMA synchronous=NORMAL` on every client instantiation; do not skip these.

Dev and prod read different SQLite files selected by `DATABASE_URL` in the environment-specific `.env` file. The five core models are: `Asset` (registry), `PriceTick` (raw ticks), `DailySummary` (pre-aggregated for chart queries), `MacroSeries` (FRED/macro indicators), and `IngestJob` (run log). All timestamps are stored as UTC.

`DailySummary` rows are generated by a nightly rollup job (`src/ingest/rollup.ts`, scheduled at 00:30 UTC) — don't write daily summaries inline during tick ingestion. The rollup also prunes `PriceTick` rows older than `TICK_RETENTION_DAYS` (env, default `90`) to bound DB size.

Prisma migrations are a **deploy-time** step — never run `prisma migrate` from a process startup path. Multiple processes booting concurrently would race on the schema lock. Deploy flow: `npx prisma migrate deploy` then `pm2 reload "pulsar*"`.

### `.env` files

`.env.development` and `.env.production` contain only `DATABASE_URL`. All API keys (`COINGECKO_API_KEY`, `ALPHA_VANTAGE_KEY`, `FRED_API_KEY`, `EXCHANGERATE_API_KEY`) plus the shared internal token (`PULSAR_INTERNAL_TOKEN`, used by ingest jobs to call `/internal/notify` and by operators to call `POST /ingest/:sourceId`) live in an untracked `.env`. Both checked-in env files are committed; the untracked `.env` is not.

### Internal endpoints & WebSocket

`POST /internal/notify` and `POST /ingest/:sourceId` both require `Authorization: Bearer ${PULSAR_INTERNAL_TOKEN}`. `/internal/notify` is how ingest jobs tell the API process to broadcast freshly-inserted ticks to WebSocket subscribers on `/ws/prices`. Public endpoints (`/assets`, `/prices`, `/history`, `/macro`, `/status`, `/health`) are unauthenticated — Cloudflare Tunnel is the security boundary.

WebSocket delivery is **best-effort, not durable**: if the API process is down when a job inserts ticks, the rows are still in the DB and a reconnecting client recovers state via REST. Do not build features that assume every tick reaches every WS client.

### Logging

`src/lib/logger.ts` adds a `proc` field on every line (`"api"`, `"rollup"`, or the `SOURCE_ID` of the ingest job) so `pm2 logs` is traceable across processes. Cross-process queryable events (start, end, row count, error) also land in the `IngestJob` table.

### PM2

Config lives in `/Users/sal/salsquared/ecosystem.config.cjs` alongside the other salsquared services. Pulsar's process entries:

- `pulsar` — prod API server (port 3103)
- `pulsar-dev` — dev API server (port 4103)
- `pulsar-ingest-{coingecko,mempool,yahoo,exchangerate,fred}` — short-lived per-source ingest jobs scheduled by `cron_restart`, all `autorestart: false`
- `pulsar-rollup` — nightly rollup at 00:30 UTC

Useful commands: `pm2 logs pulsar` (single stream) or `pm2 logs "pulsar*"` (all). After a code change: `pm2 reload "pulsar*"`.
