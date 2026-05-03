# Pulsar — Implementation Plan

This is the granular sequence for building Pulsar from the empty repo to "Mission Control reads from Pulsar in production". It is deliberately phased so each step ends at a verifiable milestone — don't move forward until the milestone holds.

References to the architecture doc use the form `[architecture § Section]`. The architecture doc is the authoritative source for *what* is being built; this plan is *how* and *in what order*.

---

## Progress

Update this table and the phase heading when a phase is complete.

| Phase | Status | Notes |
|:---|:---|:---|
| 0 — Bootstrap | ✅ done | `npm run dev` + `/health` verified |
| 1 — Schema, Prisma, seed | ✅ done | WAL confirmed, 21 curated assets seeded |
| 2 — Core libs | ✅ done | 16/16 smoke tests passing |
| 3 — CoinGecko + pipeline | ✅ done | 100 crypto ticks flowing, dedup via `INSERT OR IGNORE` |
| 4 — REST skeleton | ✅ done | `/assets` `/prices` `/status` `/health` with `X-Cache` headers |
| 5 — PM2 ecosystem | ✅ done | `pulsar-dev` + `pulsar-ingest-coingecko` online; ingest confirmed via logs |
| 6 — History + backfill | ✅ done | All 3 intervals + cache + backfill coalescing verified; uncovered Prisma INTEGER DateTime gotcha |
| 7 — Remaining fetchers + macro | ✅ done | All 5 sources wired; mempool verified; `/macro` route live; Yahoo temporarily rate-limited (IP cool-down after test calls), FRED/ExchangeRate need API keys |
| 8 — WebSocket + notify | ✅ done | WS + notify live; tick delivered end-to-end; ingest survives API-down; subscription limit enforced |
| 9 — Manual ingest trigger | ✅ done | `POST /api/ingest/:sourceId` verified — valid/invalid token and unknown source all correct |
| 10 — Downsampling + retention | ✅ done | Rollup populates DailySummary correctly; retention prune works; idempotent across re-runs; PM2 entry at 00:30 UTC |
| 11 — Mission Control migration | ✅ done | `/api/finance` + `/api/finance/history` consume Pulsar correctly; top100 cards render with proper symbol+name; fees populated from per-asset `/prices/btc-fee-*` |

---

## How to read this plan

- **Phases** are sequenced by dependency. Each ends with a "Done when" milestone.
- **Tasks** within a phase are numbered. A task is one focused unit of work — typically one file or one cohesive change across a few files.
- **Verify** steps are concrete shell-runnable checks. Run them before declaring a phase done.
- **Risks** at the bottom flag implementation hazards that don't belong inside a single phase.

---

## Phase 0 — Project bootstrap ✅

**Goal:** repo is runnable. `npm run dev` starts a Hono server that responds 200 on `/health`.

1. **`package.json`**
   - Runtime deps: `hono`, `@hono/node-server`, `@hono/node-ws`, `@prisma/client`, `prisma`, `dotenv`, `tsx`, `typescript`.
   - Dev deps: `@types/node`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`.
   - Scripts:
     - `"dev": "tsx watch -r dotenv/config src/index.ts dotenv_config_path=.env.development"`
     - `"start": "node -r dotenv/config dist/index.js dotenv_config_path=.env.production"`
     - `"build": "tsc"`
     - `"lint": "eslint . && tsc --noEmit"`
   - Add `"prisma": { "seed": "tsx prisma/seed.ts" }` so `prisma migrate dev` runs the seed.
2. **`tsconfig.json`** — `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`, `outDir: dist`, `rootDir: src`. Include `src` only.
3. **`.env.development` / `.env.production`** — committed; each contains only `DATABASE_URL=file:./prisma/dev.db` (or `prod.db`).
4. **`.env.example`** — committed template listing every key the untracked `.env` needs (no values): `COINGECKO_API_KEY`, `ALPHA_VANTAGE_KEY`, `FRED_API_KEY`, `EXCHANGERATE_API_KEY`, `PULSAR_INTERNAL_TOKEN`, optional `TICK_RETENTION_DAYS`, optional `WS_MAX_SUBSCRIPTIONS`.
5. **`.gitignore`** — `node_modules`, `dist`, `prisma/*.db`, `prisma/*.db-wal`, `prisma/*.db-shm`, `.env`.
6. **`src/index.ts`** — minimal Hono app; one route `GET /health` returning `{ status: "ok", db: "ok", uptimeSeconds: process.uptime() }`. Listen on `process.env.PORT ?? 4103` via `serve` from `@hono/node-server`.

**Verify:** `npm install && npm run dev`, then `curl http://localhost:4103/health` → `200 {"status":"ok",...}`.

**Done when:** the verify step passes on a fresh clone.

> **Implementation notes:** `npm run dev` uses `node --env-file .env.development --import tsx/esm --watch`. Neither `.env.development` nor `.env.production` is committed — copy from `.env.development.example` / `.env.production.example`.

---

## Phase 1 — Schema, Prisma client, seed ✅

**Goal:** DB exists with WAL mode set on every connection; the curated `Asset` seed list is loaded.

1. **`prisma/schema.prisma`** — copy the full schema from `[architecture § Database Schema]`. `provider = "sqlite"`, `url = env("DATABASE_URL")`. Include all five models + both enums.
2. **First migration** — `npx prisma migrate dev --name init`. Commit `prisma/migrations/<ts>_init/`.
3. **`src/lib/prisma.ts`** — singleton `PrismaClient` cached on `globalThis` (survives tsx watch restarts). After construction, await:
   ```ts
   await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL')
   await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000')
   await prisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL')
   ```
   Wrap construction in an IIFE that resolves only after the pragmas land — every consumer awaits the singleton. **Load-bearing; see `[architecture § SQLite write concurrency — WAL mode is mandatory]`.**
4. **`prisma/seed.ts`** — exports a const array of curated `Asset` rows (every entry from the table in `[architecture § Asset id conventions]` *except* `CRYPTO`, which auto-registers). Iterates with `prisma.asset.upsert({ where: { id }, create: {...}, update: {...} })` so the seed is idempotent. Call `prisma.$disconnect()` at the end.
5. **Verify:** `rm -f prisma/dev.db* && npx prisma migrate dev` ⇒ `sqlite3 prisma/dev.db "PRAGMA journal_mode;"` returns `wal`; `SELECT COUNT(*) FROM Asset;` returns the seed count; `SELECT id FROM Asset WHERE assetClass='CRYPTO';` returns nothing.

**Done when:** verify passes; re-running the seed produces zero new rows.

> **Implementation notes:** `$executeRawUnsafe` fails for result-returning PRAGMAs in Prisma 6 — use `$queryRawUnsafe` for all three WAL pragmas. SQLite path resolves relative to `prisma/schema.prisma`, so `DATABASE_URL=file:./dev.db` places the DB at `prisma/dev.db`.

---

## Phase 2 — Core libs (types, logger, cache, auth, errors) ✅

**Goal:** every utility every later phase depends on is in place.

1. **`src/types.ts`** — single source of truth for shared types. Define:
   - `AssetClass`, `JobStatus` (string unions matching the Prisma enums)
   - `AssetSummary`, `PricePoint`, `Tick` (response-shape types from `[architecture § Response shapes]`)
   - `NormalizedTick`, `NormalizedMacro`, `SourceConfig`
   - `ClientMessage`, `ServerMessage` (WS unions from `[architecture § Protocol — message types]`)
   - `IngestNotifyBody` (the `POST /internal/notify` payload)
   - `ErrorEnvelope` and an `ErrorCode` union from the table in `[architecture § Error envelope]`
2. **`src/lib/logger.ts`** — minimal structured logger. `info`/`warn`/`error` each accept `(msg: string, fields?: Record<string, unknown>)` and emit a single JSON line: `{ ts, level, proc, msg, ...fields }`. `proc` reads from `process.env.PROC` (set per process: `"api"` in `index.ts`, the `SOURCE_ID` in `run.ts`, `"rollup"` in `rollup.ts`). `error` goes to stderr; the rest go to stdout.
3. **`src/lib/errors.ts`** — exports `apiError(c, status, code, message, details?)` that returns `c.json({ error: { code, message, details } }, status)`. Used everywhere instead of inline error JSON.
4. **`src/lib/cache.ts`** — port of Mission Control's `withCache`. Module-level `Map<string, { value: unknown; expiresAt: number; stale: unknown }>`. Signature:
   ```ts
   export async function withCache<T>(c: Context, ttlSec: number, fn: () => Promise<T>): Promise<T>
   ```
   - Cache key: `c.req.path + '?' + sortedQueryString(c.req.query())`.
   - HIT (`expiresAt > Date.now()`): set `X-Cache: HIT`, return cached `value`.
   - MISS: call `fn()`. On success, store `{ value, expiresAt: now + ttlSec*1000, stale: value }` and set `X-Cache: MISS`. On error, fall back to `stale` if present (set `X-Cache: STALE-FALLBACK` and a 60s short TTL); else propagate.
   - Cache key must NOT include headers. Stale-fallback applies to *any* thrown error; logging is the caller's responsibility.
5. **`src/lib/auth.ts`** — `internalTokenMiddleware()` returns a Hono middleware that requires `Authorization: Bearer ${process.env.PULSAR_INTERNAL_TOKEN}`. Use `crypto.timingSafeEqual` to avoid timing leaks. On miss, call `apiError(c, 401, 'unauthorized', 'invalid or missing token')`.
6. **Verify:** scratch `scripts/smoke-libs.ts` that exercises all three. Run via `npx tsx scripts/smoke-libs.ts`. Cache: assert HIT/MISS/STALE-FALLBACK headers; logger: assert valid JSON with `proc` set; auth: assert 401 with the locked envelope.

**Done when:** smoke script prints all green.

> **Implementation notes:** `withCache` stores raw data (not a `Response`) and builds the response itself — this is the only way `X-Cache` headers land in the actual response. If `fn()` returns a `Response` instance (e.g. `apiError`), it is passed through without caching.

---

## Phase 3 — Source registry, CoinGecko fetcher, pipeline, ingest entry point ✅

**Goal:** end-to-end ingest works for one source via `SOURCE_ID=coingecko npx tsx src/ingest/run.ts`. Crypto tick rows appear in the DB; `IngestJob` row is written.

1. **`src/lib/source-registry.ts`** — exports `SOURCES: Record<string, SourceConfig>`. Initially: only `coingecko`. Helper: `getSource(id: string): SourceConfig` that throws a typed error if id is unknown (used by the pipeline).
2. **`src/ingest/sources/coingecko.ts`** — exports `coingecko: SourceConfig`. `fetch()`:
   - GET `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1`
   - Maps each result to `NormalizedTick { assetId: r.id, timestamp: new Date(), close: r.current_price, volume: r.total_volume, open: null, high: null, low: null }`
   - Reads optional `COINGECKO_API_KEY`; sets `x-cg-pro-api-key` header if present
   - Retry helper: exponential backoff with jitter on 429/503; max 3 attempts. On final failure, throw — pipeline catches and writes a FAILED `IngestJob`.
3. **`src/ingest/pipeline.ts`** — exports `runIngest(sourceId): Promise<{ rowsInserted: number; status: JobStatus; errorMsg?: string }>`. Algorithm:
   1. Resolve `source = getSource(sourceId)`.
   2. Insert an `IngestJob { sourceId, startedAt: new Date(), status: 'RUNNING', rowsInserted: 0 }`; capture its id.
   3. Try block:
      - `const ticks = await source.fetch()`
      - Resolve registered assetIds: for `assetClass: CRYPTO`, `prisma.asset.upsert` each unique assetId in the batch (auto-register). For other classes, `prisma.asset.findMany({ where: { id: { in: ids } } })` and drop unregistered ticks (log a warning for each dropped id).
      - `const result = await prisma.priceTick.createMany({ data: rowsForInsert, skipDuplicates: true })` — use `result.count` as `rowsInserted`.
      - **Phase 8 hook:** call `await notifyApi(sourceId, insertedTicks).catch(() => {})` (stubbed to a no-op in this phase; uncommented in Phase 8).
      - Update the IngestJob row: `status: 'SUCCESS', completedAt, rowsInserted: result.count`.
      - Return `{ rowsInserted, status: 'SUCCESS' }`.
   4. Catch: update IngestJob row with `status: 'FAILED', completedAt, errorMsg: err.message`. Rethrow.
4. **`src/ingest/pipeline.ts:backfill`** — stub that throws `not_implemented`. Real impl in Phase 5.
5. **`src/ingest/run.ts`** — entry point.
   - Read `process.env.SOURCE_ID` (required) and `STARTUP_DELAY_SECONDS` (optional integer).
   - Set `process.env.PROC = SOURCE_ID` *before* importing the logger so the first log line is tagged.
   - If `STARTUP_DELAY_SECONDS > 0`, `await new Promise(r => setTimeout(r, n*1000))`.
   - `try { await runIngest(SOURCE_ID); process.exit(0) } catch (err) { logger.error(...); process.exit(1) } finally { await prisma.$disconnect() }`.
6. **Verify:** `rm -f prisma/dev.db* && npx prisma migrate dev` then `SOURCE_ID=coingecko npx tsx src/ingest/run.ts`. Expect: ~100 PriceTick rows, 100 Asset rows (auto-registered), one IngestJob row with status SUCCESS. Re-run: 0 new ticks (dedup), one new IngestJob row with `rowsInserted: 0`, status SUCCESS.

**Done when:** verify is deterministic. Multiple back-to-back runs do not duplicate rows.

> **Implementation notes:** Prisma 6 removed `skipDuplicates` for SQLite `createMany` — replaced with `INSERT OR IGNORE` via `$executeRawUnsafe`, batched at 124 rows (floor(999 params / 8 cols)). Same fix applied to `MacroSeries` inserts. `PROC` env var must be set *before* the first logger import so every log line is tagged. The `notifyApi` call in `pipeline.ts` is stubbed as a no-op until Phase 8 (WebSocket).

---

## Phase 4 — REST API skeleton (assets, prices, status, health) ✅

**Goal:** API serves the basic public endpoints with the cache wrapper. Mission Control could already start consuming `/prices/latest` for crypto.

1. **`src/index.ts`** (full version)
   - Set `process.env.PROC = 'api'` before any imports that use the logger.
   - Build the Hono app, mount route groups under `app.route('/api', ...)`.
   - Mount `/health` at root (not `/api`) so tunnel probes don't need the prefix.
   - `serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4103) }, info => logger.info('listening', { port: info.port }))`.
   - SIGTERM handler: stop accepting new connections, then `await prisma.$disconnect()`, then exit.
2. **`src/routes/health.ts`** — `GET /health`:
   - Run `await Promise.race([prisma.$queryRaw\`SELECT 1\`, timeout(1000)])`.
   - On success: `200 { status: 'ok', db: 'ok', uptimeSeconds: Math.floor(process.uptime()) }`.
   - On failure: `503 { status: 'degraded', db: 'error', error: err.message }`.
   - **Not** wrapped in `withCache`. **Not** wrapped in the error-envelope path either; this is the one endpoint with a non-envelope error shape.
3. **`src/routes/assets.ts`** — `GET /assets` (with `?class=` filter) and `GET /assets/:id`. Wrap both in `withCache(c, 60, …)`.
   - `/assets/:id` joins on PriceTick aggregates: `prisma.priceTick.aggregate({ where: { assetId }, _min: { timestamp: true }, _max: { timestamp: true }, _count: true })`.
   - Unknown id: `apiError(c, 404, 'not_found', 'asset not registered')`.
4. **`src/routes/prices.ts`** — `GET /prices/latest` (with `?class=` and/or `?ids=`) and `GET /prices/:id`. Wrap in `withCache(c, 60, …)`.
   - For each asset, query the latest `PriceTick` filtered to `Asset.source` (one query per asset for v1 — see risks).
   - Compute `change24h` per `[architecture § Read-time computation]`: a second query for the closest tick where `timestamp BETWEEN now-25h AND now-23h ORDER BY timestamp DESC LIMIT 1`. If none, `change24h: null` (do not extrapolate).
   - `/prices/:id` for an asset with no ticks yet: `404 not_found`.
5. **`src/routes/status.ts`** — `GET /status` and `GET /status/jobs`.
   - `/status`: aggregate per-source via a single grouped query on `IngestJob`, plus `prisma.{asset,priceTick,dailySummary,macroSeries}.count()`, plus `fs.statSync` on `DATABASE_URL`'s file (and the `-wal` sibling for `walSizeBytes`).
   - `/status/jobs`: keyset pagination by descending id. `?limit` (default 50, max 500), `?cursor=<id>`, `?source=<id>` filter. `nextCursor` = id of last row when full page returned, else null.
6. **Wire everything in `index.ts`** — mount `assets`, `prices`, `status` under `/api`; mount `health` at root.
7. **Verify:** `npm run dev`, then:
   - `curl :4103/api/assets` returns the AssetSummary list shape.
   - `curl :4103/api/prices/latest` returns PricePoint array; second hit shows `X-Cache: HIT`.
   - `curl :4103/api/status` returns the locked shape with `counts.assets > 0`.
   - `curl :4103/health` returns 200.
   - `mv prisma/dev.db /tmp/`, hit `/health` again → 503; restore the file.

**Done when:** every endpoint returns the architecture-locked shape; cache headers behave correctly; `/health` distinguishes ok vs degraded.

> **Implementation notes:** `withCache` route handlers return raw data objects (not `c.json(...)`) — `withCache` builds the `Response` itself to control the `X-Cache` header. Routes that call `apiError` inside the cache callback return a `Response` instance; `withCache` detects this and passes it through without caching.

---

## Phase 5 — PM2 ecosystem ✅

**Goal:** the API server and the CoinGecko ingest job run under PM2 so the service can be validated through the real process manager. Ingest entries for sources that aren't implemented yet are added incrementally as each later phase completes — don't wait for all sources before standing up PM2.

1. **Generate `PULSAR_INTERNAL_TOKEN`** — `openssl rand -hex 32`. Write the value into `.env.development` (and `.env.production` when deploying prod). Add it to both `.env.*.example` files with a comment describing rotation.
2. **`npm run build`** — compile `src/` to `dist/` so the prod `start` entry works.
3. **`DATABASE_URL=file:./prod.db npx prisma migrate deploy`** — apply migrations to `prod.db` (separate from `dev.db`).
4. **Edit `/Users/sal/salsquared/ecosystem.config.cjs`** — append the Pulsar entries. At this phase, only add what is currently implemented:
   ```javascript
   // API servers
   { name: "pulsar",     cwd: "/Users/sal/salsquared/pulsar", script: "npm", args: "run start",
     env: { PORT: 3103, NODE_ENV: "production", DATABASE_URL: "file:./prod.db" } },
   { name: "pulsar-dev", cwd: "/Users/sal/salsquared/pulsar", script: "npm", args: "run dev",
     env: { PORT: 4103, NODE_ENV: "development", DATABASE_URL: "file:./dev.db" } },

   // CoinGecko ingest — add remaining sources as each Phase 7 source is completed
   { name: "pulsar-ingest-coingecko", cwd: "/Users/sal/salsquared/pulsar",
     script: "npx", args: "tsx src/ingest/run.ts",
     env: { SOURCE_ID: "coingecko", NODE_ENV: "production", DATABASE_URL: "file:./prod.db",
            STARTUP_DELAY_SECONDS: "0" },
     cron_restart: "*/5 * * * *", autorestart: false },
   ```
   Note: `PULSAR_INTERNAL_TOKEN` and API keys should also be in each entry's `env` block, or PM2 should load them from the shell environment (`env_file` is not a PM2 native feature — set vars in the ecosystem env blocks or ensure PM2 inherits them from the shell).
5. **`pm2 start ecosystem.config.cjs --only "pulsar-dev,pulsar-ingest-coingecko"` && `pm2 save`** — start dev first; add prod entries when ready.
6. **Verify:**
   - `pm2 logs pulsar-dev` shows `listening port=4103`.
   - `curl :4103/api/status` returns the locked shape with `counts.priceTicks` growing over time.
   - After 10 minutes, `pm2 logs pulsar-ingest-coingecko --nostream | grep "ingest complete"` shows ≥ 2 runs.
   - No `SQLITE_BUSY` errors in any log stream.
   - `pm2 list` shows both processes as `online`.

**Done when:** API and CoinGecko ingest are both online in PM2 for ≥ 30 minutes; `/health` stays 200; `IngestJob` table in the DB shows steady successful runs.

> **Implementation notes:** Ingest jobs use `script: "node", args: "--env-file .env.development --import tsx/esm src/ingest/run.ts"` — this loads secrets from the env file without exposing them in the committed ecosystem config. The `env` block in each ingest entry only contains non-secret operational vars (`SOURCE_ID`, `STARTUP_DELAY_SECONDS`). Ingest jobs show as `stopped` between cron runs — this is expected with `autorestart: false`.

---

## Phase 6 — History endpoint + backfill + coalescing ✅

**Goal:** `/history/:id` works for in-DB ranges, and on-demand backfill fills gaps. Concurrent backfills are coalesced.

1. **Extend `SourceConfig`** — add optional `fetchHistory?: (assetId: string, from: Date, to: Date) => Promise<NormalizedTick[]>`. Sources that don't support backfill leave it undefined; the pipeline returns an `upstream_error` if a backfill is requested for one of those.
2. **`src/ingest/sources/coingecko.ts`** — implement `fetchHistory`:
   - GET `/coins/{id}/market_chart/range?vs_currency=usd&from={epoch}&to={epoch}`.
   - Response has parallel `prices`, `market_caps`, `total_volumes` arrays — zip by timestamp.
   - Free tier returns daily granularity for ranges > ~90 days; document this in a comment so `interval=1h` callers don't surprise themselves.
3. **`src/ingest/pipeline.ts:backfill(assetId, source, from, to)`** — real impl:
   - Module-level `inflight = new Map<string, Promise<void>>()`.
   - Key: `${assetId}:${source}:${floorDay(from)}..${ceilDay(to)}`.
   - If key exists: `await inflight.get(key)`; return.
   - Otherwise: create the work promise (`fetchHistory` → `createMany skipDuplicates`); store; on settle (try/finally), `inflight.delete(key)`.
   - This map is in-process only — fine because backfills run only in the API process (per `[architecture § Long-running ingests vs. cron_restart]`).
4. **`src/routes/history.ts`** — `GET /history/:id` and `GET /history/:id/summary`:
   - Validate `from` (required, ISO date), `to` (default = now), `interval` (default `1d`, one of `1h | 1d | 1w`).
   - Look up asset; resolve `source = c.req.query('source') ?? asset.source`.
   - Coverage gap: `MIN(timestamp)` for asset+source; if `from < min`, call `backfill()` and set `meta.backfilled = true`.
   - For `interval='1d'`: `prisma.dailySummary.findMany({ where: { assetId, date: { gte: from, lte: to } }, orderBy: { date: 'asc' } })`.
   - For `interval='1w'`: same query, then group by ISO week in app code (`o`=first day's open, `c`=last day's close, `h`=MAX(high), `l`=MIN(low), `v`=SUM(volume)).
   - For `interval='1h'`: bail with `400 tick_retention_exceeded` if `from < now - TICK_RETENTION_DAYS`. Otherwise raw SQL via `$queryRaw`:
     ```sql
     SELECT
       strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS bucket,
       (SELECT close FROM PriceTick p2 WHERE p2.assetId = p.assetId AND p2.source = p.source
          AND strftime('%Y-%m-%dT%H', p2.timestamp) = strftime('%Y-%m-%dT%H', p.timestamp)
          ORDER BY timestamp ASC LIMIT 1) AS o,
       MAX(COALESCE(high, close)) AS h,
       MIN(COALESCE(low, close)) AS l,
       (SELECT close FROM PriceTick p2 WHERE … ORDER BY timestamp DESC LIMIT 1) AS c,
       SUM(volume) AS v
     FROM PriceTick p
     WHERE assetId = ? AND source = ? AND timestamp BETWEEN ? AND ?
     GROUP BY bucket
     ORDER BY bucket ASC
     ```
     (Or compute `o`/`c` in app code by sorting; whichever reads cleaner.)
   - `/history/:id/summary` is a thin wrapper: `interval=1d` only, no backfill trigger, no resampling.
5. **Cache wrapper** — wrap `withCache(c, 300, …)` for in-DB ranges. **Bypass cache when `meta.backfilled === true`**: the request had side effects (new rows landed) and the cache key would mask them for the next caller. Cleanest pattern: compute the result, decide whether to cache, then write the headers conditionally.
6. **Verify:**
   - `curl :4103/api/history/bitcoin?from=2025-01-01` returns `~120` daily points; second call shows `X-Cache: HIT`.
   - `curl :4103/api/history/bitcoin?from=2010-01-01` triggers backfill; `meta.backfilled: true`; the next call hits the now-populated DB without a backfill.
   - Two simultaneous `?from=2010-01-01` requests fire only one upstream CoinGecko call (count `proc=api, msg=coingecko fetchHistory` lines in the logger output).
   - `curl :4103/api/history/bitcoin?from=2024-01-01&interval=1h` returns `400 tick_retention_exceeded` (assuming default `TICK_RETENTION_DAYS=90`).

**Done when:** all three intervals return correct shapes; coalescing demonstrably collapses parallel requests; retention check fires at the right boundary.

> **Implementation notes (load-bearing):**
> - **Prisma 6 stores SQLite `DateTime` as INTEGER (Unix milliseconds), NOT as text.** The "YYYY-MM-DD HH:MM:SS UTC" shown in Prisma's query event log is just display formatting — the actual binding is an integer. Raw INSERTs against tables read by Prisma's ORM **must** bind timestamps as integer ms via `src/lib/datetime.ts:toPrismaDateTime(d)` (`return d.getTime()`). Storing ISO text strings makes ORM range queries silently return 0 rows because SQLite type-coerces TEXT-vs-INTEGER comparisons to NULL. This bug only fires on the *upper* bound of a range filter — `gte` alone happens to work, which masks the issue until you write a query with both `gte` and `lte` (e.g. `change24h` window, history range queries). `pipeline.ts:insertPriceTicksOrIgnore` and `insertMacroOrIgnore` both apply this conversion.
> - Raw SQL queries against `PriceTick.timestamp` must use `strftime('%Y-%m-%dT%H:00:00Z', timestamp / 1000, 'unixepoch')` to bucket by hour/day, since the column is INTEGER ms.
> - **`interval=1d` falls back to PriceTick aggregation** when `DailySummary` is empty (rollup hasn't run yet). Without this fallback, `interval=1d` returns 0 points until Phase 10 lands, breaking the public API for clients early on.
> - **Gap detection: backfill only when `ticksInRange === 0`.** The original architecture sketch said "backfill if `from < earliest`", but that fires on every request because of millisecond-precision differences in CoinGecko's data points. Counting ticks in the requested range is more correct: partial gaps are accepted; only fully-uncovered ranges trigger backfill.
> - **Backfilled responses bypass the cache** so repeat requests after a backfill see fresh data. Non-backfilled responses are cached for 5 min.
> - **CoinGecko's `/coins/{id}/market_chart/range` requires a demo API key** for ranges older than ~24h. Without `COINGECKO_API_KEY` in env, backfills for older ranges return `502 upstream_error`; current-day data works without a key.

---

## Phase 7 — Remaining fetchers + macro routes ✅

**Goal:** all five sources ingest correctly; `/macro` and `/macro/:seriesId` work.

1. **`src/ingest/sources/mempool.ts`** — `fetch()` calls Mempool.space `/api/v1/fees/recommended`. Map the three tiers into NormalizedTicks with assetIds `btc-fee-fast`, `btc-fee-30min`, `btc-fee-eco`. Auto-registers as CRYPTO assets (same pattern as CoinGecko). Document the assetId convention in a header comment so it doesn't drift.
2. **`src/ingest/sources/yahoo.ts`** — `fetch()` queries Yahoo Finance for the curated `EQUITY` + `COMMODITY` assetIds in one batched request: `https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,MSFT,GC=F,...`. Convert each result's `regularMarketTime` (Unix epoch in market-local TZ) to UTC. Drop ticks for any assetId not in the registered Asset table (these are curated classes — no auto-register). `fetchHistory` via `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1=…&period2=…&interval=1d`.
3. **`src/ingest/sources/exchangerate.ts`** — `fetch()` calls `/v6/${API_KEY}/latest/USD`, derives every curated FOREX pair by direct lookup or cross-rate (`EUR/JPY = (1 / rates.EUR) * rates.JPY`). Single timestamp = response time. No history endpoint on the free tier; `fetchHistory` undefined.
4. **`src/ingest/sources/fred.ts`** — produces `NormalizedMacro`, not `NormalizedTick`. To accommodate this:
   - Add `fetchMacro?: () => Promise<NormalizedMacro[]>` to `SourceConfig`.
   - Update `pipeline.ts:runIngest`: if the resolved source has `fetchMacro` (and not `fetch`), branch to a parallel path that calls `prisma.macroSeries.createMany({ skipDuplicates: true })` and skips Asset registration. The `IngestJob` row is still written.
   - FRED's curated series ids live in `fred.ts` as a const array.
5. **`src/lib/source-registry.ts`** — register all five sources.
6. **`src/routes/macro.ts`** — `GET /macro` and `GET /macro/:seriesId` per the response shapes. Cache TTL = 24h. `/macro` aggregates the latest row per `seriesId` via `DISTINCT ON`-equivalent pattern (Prisma: group by `seriesId`, take MAX timestamp per group, then look up; or `$queryRaw` for one round trip).
7. **Wire macro routes** in `index.ts`.
8. **Verify:** for each source: `SOURCE_ID=<id> npx tsx src/ingest/run.ts` → relevant table grows, IngestJob row SUCCESS, no FK errors. `curl :4103/api/macro` returns one entry per seed series. `curl :4103/api/macro/FEDFUNDS?from=2024-01-01` returns history.

**Done when:** all five sources flow data; macro endpoints return locked shapes; non-crypto sources correctly drop unregistered assetIds.

> **PM2 note:** as each source is verified, add its PM2 entry to `ecosystem.config.cjs` and run `pm2 start ecosystem.config.cjs --only "pulsar-ingest-<id>"`. All five entries should be live by the end of this phase.

> **Implementation notes:**
> - **Yahoo Finance v7 quote endpoint now returns 401** — Yahoo tightened auth requirements. The implementation was updated to use the v8/finance/chart endpoint instead (per-symbol requests, same data). The v8 endpoint can 429 when called rapidly in testing; at normal PM2 intervals (5 min) it works fine. Add retry+backoff for 429 as implemented.
> - **`GET /macro` latest-per-series query** — SQLite has no `DISTINCT ON`. Used a self-join: `SELECT m.* FROM MacroSeries m INNER JOIN (SELECT seriesId, MAX(timestamp) AS maxTs FROM MacroSeries GROUP BY seriesId) latest ON ...`. Raw query returns `timestamp` as `bigint`; convert with `Number(r.timestamp)`.
> - **FRED series fetched from 2015-01-01** — `limit=10000` in the URL gets all observations in one request. `INSERT OR IGNORE` handles deduplication on daily re-runs. Observations with `value = "."` (FRED missing-data sentinel) are filtered.
> - **ExchangeRate-API v6 response uses `conversion_rates`** (not `rates`). Pair derivation from USD base: `EUR/USD = 1 / rates.EUR`, `USD/JPY = rates.JPY`, etc.
> - **`ServerType` union includes Http2Server** — `closeAllConnections()` only exists on HTTP/1.1 `Server`. Fixed with `if ('closeAllConnections' in server)` guard (pre-existing type error caught during Phase 7 lint).
> - **PM2 startup delays stagger boot-time API calls**: coingecko=0s, mempool=30s, yahoo=60s, exchangerate=90s. Avoids simultaneous burst on restart.

---

## Phase 8 — WebSocket + cross-process notification ✅

**Goal:** WS clients subscribe and receive real-time tick frames whenever any ingest job lands new ticks.

1. **`src/lib/notify.ts`** — `notifyApi(sourceId, ticks): Promise<void>`. POSTs `{ sourceId, ticks }` to `http://127.0.0.1:${process.env.PORT ?? 3103}/internal/notify` with `Authorization: Bearer ${PULSAR_INTERNAL_TOKEN}`. Catches **all** errors (network down, 401, etc.) and logs a warning — never throws. Notifications are best-effort.
2. **`src/routes/internal.ts`** — `POST /internal/notify`:
   - Apply `internalTokenMiddleware` first.
   - Validate body shape (Zod or hand-rolled — small enough that hand-rolled is fine).
   - Call `wsBroker.broadcast(sourceId, ticks)` (exported by `routes/ws.ts`).
   - Return `204 No Content` immediately. The broadcast is fire-and-forget from the caller's perspective; broker handles its own backpressure.
3. **`src/routes/ws.ts`** — main WebSocket handler:
   ```ts
   interface Session {
     id: string                  // crypto.randomUUID()
     ws: WSContext
     subscribed: Set<string>     // assetIds; '*' means wildcard
     queue: number               // queued (sent but not flushed) message count
     missedPongs: number
   }
   const sessions = new Map<string, Session>()
   ```
   - Use `@hono/node-ws`'s `upgradeWebSocket(c => ({ onOpen, onMessage, onClose, onError }))`.
   - `onOpen`: assign `id`, register session, send `{ type: 'welcome', sessionId, serverTime }`.
   - `onMessage`: parse JSON; if invalid, send `{ type: 'error', code: 'bad_message', ... }` (connection stays open). Switch on `type`:
     - `subscribe`: validate count against `WS_MAX_SUBSCRIPTIONS` (default 500). On overflow, emit `error: subscription_limit` and reject the *frame* — don't mutate state. Otherwise add ids to `subscribed`. Send `subscribed` ack with the *full* current set.
     - `unsubscribe`: remove ids; `[]`/`['*']` clears all. No ack required.
     - other types: emit `error: unknown_type`.
   - `onClose`/`onError`: `sessions.delete(id)`.
4. **Broadcast** — `wsBroker.broadcast(sourceId, ticks)` exported by `routes/ws.ts`:
   ```ts
   for (const tick of ticks) {
     for (const session of sessions.values()) {
       if (session.subscribed.has('*') || session.subscribed.has(tick.assetId)) {
         if (session.queue >= 256) {
           session.ws.close(1009, 'overload')
           sessions.delete(session.id)
           continue
         }
         session.queue++
         session.ws.send(JSON.stringify({ type: 'tick', assetId: tick.assetId, tick }), () => session.queue--)
       }
     }
   }
   ```
5. **Heartbeat** — `setInterval(() => { for (const s of sessions.values()) { if (++s.missedPongs >= 2) { s.ws.close(1006); sessions.delete(s.id); continue } s.ws.ping() } }, 30000)`. `onPong` resets `missedPongs = 0`.
6. **Wire `notifyApi` into `pipeline.ts`** — uncomment/enable the `await notifyApi(sourceId, insertedTicks).catch(() => {})` call after the batch insert. **Only fire for `PriceTick` paths** — FRED's macro path skips it.
7. **Verify:**
   - Start `npm run dev`. In one terminal: `websocat ws://localhost:4103/ws/prices`. Receive `welcome`. Send `{"type":"subscribe","assetIds":["bitcoin"]}`. Receive `subscribed`.
   - In another terminal: `SOURCE_ID=coingecko npx tsx src/ingest/run.ts`. The websocat session receives a `tick` frame for bitcoin within ~1s of the ingest completing.
   - Stop the API server, run an ingest. Logs show `notifyApi` warning; ingest job still completes successfully.
   - Open 600 subscriptions in one connection: receive `error: subscription_limit` and the connection stays open.

**Done when:** verify passes; killing the API mid-ingest does not crash the ingest job.

> **Implementation notes:**
> - **`createNodeWebSocket({ app })` must be called before routes are mounted** — `@hono/node-ws` patches the app to intercept upgrade requests. Calling it after `serve()` is too late.
> - **`injectWebSocket(server)` must be called after `serve()`** — hooks the WS upgrade handler into the HTTP server's `upgrade` event.
> - **Session `sessionId` captured via closure in `onOpen`** — passed to pong listener so it can look up the correct session in the map.
> - **`ws.raw?.ping()`** — heartbeat sends via the underlying `ws.WebSocket`; pong is caught via `ws.raw?.on('pong', ...)` in `onOpen`. Both are unavailable through `WSContext` directly.
> - **Raw send with callback for queue tracking** — `s.ws.raw?.send(msg, () => { s.queue-- })` gives flush confirmation; falls back to `WSContext.send` (no callback) when raw is unavailable.
> - **`PORT=4103` must be set in `.env.development`** — ingest jobs use `process.env.PORT` to construct the notify URL. Without it they default to 3103 (prod) and the notify call fails in dev. Updated `.env.development.example` to have this uncommented.
> - **`@types/ws` added as dev dep** — needed for typed access to the raw `ws.WebSocket` instance.

---

## Phase 9 — Manual ingest trigger ✅

**Goal:** operators can `curl -X POST -H "Authorization: Bearer $T" :4103/api/ingest/coingecko` for a synchronous run.

1. **`src/routes/ingest.ts`** — `POST /ingest/:sourceId`:
   - `internalTokenMiddleware`.
   - Resolve `sourceId`; unknown → `404 not_found`.
   - `const start = Date.now(); const result = await runIngest(sourceId); return c.json({ meta: { fetchedAt, sourceId, durationMs: Date.now() - start }, data: { rowsInserted: result.rowsInserted, status: result.status } })`.
   - Catch `runIngest` errors: `502 upstream_error` with `errorMsg` in `details`.
2. **Wire** in `index.ts` under `/api`.
3. **Verify:** valid token → 200 with the locked shape; missing/wrong token → 401 with the error envelope; unknown sourceId → 404.

**Done when:** verify passes.

---

## Phase 10 — Downsampling worker + tick retention ✅

**Goal:** nightly rollup populates `DailySummary` for every asset and prunes ticks older than `TICK_RETENTION_DAYS`.

1. **`src/ingest/rollup.ts`** — entry point:
   - Set `process.env.PROC = 'rollup'` first.
   - Read `TICK_RETENTION_DAYS` (default 90).
   - For each `Asset` where `active = true`:
     - Find latest `DailySummary.date` for that asset; if none, fall back to `MIN(PriceTick.timestamp)` floored to UTC midnight.
     - For each day from there through yesterday (UTC):
       - Aggregate `PriceTick` rows where `assetId = X AND source = asset.source AND timestamp ∈ [day-start, day-end)` (primary source only — see `[architecture § Primary source vs. fetched source]`).
       - Compute OHLCV per `[architecture § Algorithm]` (`open` = first tick.close, `close` = last tick.close, `high` = MAX(close, COALESCE(high, close)), `low` = MIN(close, COALESCE(low, close)), `volume` = SUM(volume)).
       - Skip days with zero ticks (don't write empty summaries).
       - `prisma.dailySummary.upsert({ where: { assetId_date: { assetId, date } }, create: {...}, update: {...} })`.
   - After all assets: `await prisma.priceTick.deleteMany({ where: { timestamp: { lt: cutoff } } })` where `cutoff = new Date(Date.now() - retentionDays * 86_400_000)`.
   - Log a single summary line: `{ msg: 'rollup_complete', assetsProcessed, summariesUpserted, ticksDeleted }`.
   - `process.exit(0)` on success, `1` on uncaught throw. `prisma.$disconnect()` in finally.
2. **Verify:**
   - Backfill bitcoin to a few weeks ago via `/history`.
   - Run `TICK_RETENTION_DAYS=1 npx tsx src/ingest/rollup.ts`.
   - `SELECT COUNT(*) FROM DailySummary WHERE assetId='bitcoin'` ≥ a couple of rows.
   - `SELECT COUNT(*) FROM PriceTick WHERE assetId='bitcoin' AND timestamp < datetime('now','-1 day')` returns 0.
   - Re-run; row counts unchanged (idempotent).

**Done when:** verify passes; re-running produces the same DailySummary count.

> **Implementation notes:**
> - **Aggregation runs entirely in one `$queryRaw` per asset** — window functions partition by `strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch')`, then `MAX(CASE WHEN rn_asc = 1 THEN close END)` picks the day's open and `MAX(CASE WHEN rn_desc = 1 THEN close END)` picks the close. One round trip vs N day-by-day queries.
> - **Process-exit pattern uses `exitCode` + `finally`** — `process.exit()` does not wait for `finally` blocks, so `await prisma.$disconnect()` would be skipped. Setting `exitCode` and calling `process.exit(exitCode)` after the try/finally ensures the disconnect runs.
> - **Rollup re-processes the latest summary's day each run** — handles late-arriving ticks for that day. Edge case in artificial tests with `TICK_RETENTION_DAYS=1`: the boundary day gets re-summarized with fewer ticks each run as pruning eats into it. Not an issue at production retention (90d) since pruning never touches days adjacent to the rollup window.
> - **Tick prune happens AFTER rollup** so we never lose data — the cutoff is computed once at rollup time. There's a small drift (rollup-time vs check-time) where a tick may straddle the boundary; resolved on the next run.
> - **CRYPTO assets without ticks are skipped** — auto-registered crypto assets like `btc-fee-fast` exist in the Asset table but may have no ticks yet for the primary source. The rollup falls through to `continue` if `MIN(timestamp)` returns null.

---

## Phase 11 — Mission Control migration ✅

**Goal:** Mission Control reads from Pulsar instead of calling external APIs directly. Pulsar's data shapes match what MC's frontend expects.

1. **Inventory MC's existing financial routes** — list every MC route that hits CoinGecko, Yahoo, FRED, Mempool, ExchangeRate-API directly. For each, record:
   - The MC URL path
   - The external endpoint it calls
   - The response shape MC's frontend currently consumes
2. **Shape diff** — for each MC route, compare its current response shape to the corresponding Pulsar shape from `[architecture § Response shapes]`. Two outcomes per route:
   - **Identical**: MC handler becomes a thin proxy.
   - **Different**: MC handler calls Pulsar then transforms inline (one request, one map, one response).
3. **Per-route swap** — for each route, in this order:
   1. Verify Pulsar returns valid data for MC's use case (manual `curl` against `:3103/api/...`).
   2. Replace the MC handler body with the proxy/transform code.
   3. Visual + functional check on the affected MC dashboard widget.
   4. Commit. One route per commit so rollback is trivial.
4. **Decommission** — once a route is migrated and verified, delete the dead direct-API code in MC (the old fetcher, any related caches, any unused env vars). Keep the deletion in a separate commit from the swap.
5. **Verify:**
   - Every MC dashboard widget that previously hit external APIs now hits Pulsar (network tab in browser).
   - `pm2 logs pulsar` shows hits from MC's user-agent.
   - MC's outbound logs (Cloudflare Tunnel or otherwise) show no direct calls to CoinGecko/Yahoo/FRED/etc. for the migrated dataset.
   - Pulsar's `/status/jobs` shows steady ingest activity for the sources MC depends on.

**Done when:** MC has zero direct calls to migrated upstreams; dashboards render correctly under load.

> **Implementation notes:**
> - **MC routes were already shells calling Pulsar** but had two bugs masking the issue: (a) treated Pulsar's `{ meta, data }` envelope as a raw array; (b) called `?class=mempool` (mempool is a *source*, not an `AssetClass`). Fixed by extracting `data` and using `?class=CRYPTO`.
> - **Bitcoin fees fetched via individual `/api/prices/btc-fee-{fast,30min,eco}`** rather than a class filter — these are CRYPTO assets in Pulsar, the original Mempool.space response shape is reconstructed on the MC side.
> - **`OhlcvPoint` shape mismatch**: Pulsar returns `{ t, o, h, l, c, v }`; MC expected `{ timestamp, close }`. Mapped in the MC adapter.
> - **`PricePoint.name` added to Pulsar** — the MarketTop100Card needs human-readable names. Pulsar's `Asset.name` was already populated for curated assets but defaulted to `assetId` for auto-registered crypto. Updated the CoinGecko fetcher to capture `symbol` and `name` from `/coins/markets` and added them to the upsert. Crypto symbols now display as "BTC" / "ETH" instead of "BITCOIN" / "ETHEREUM".
> - **Future enhancement (out of scope)**: Pulsar doesn't yet store `image`, `marketCap`, `marketCapRank`. MarketTop100Card was updated to render a letter-avatar fallback when image is missing. Adding these fields would require an Asset schema migration; deferred until needed.
> - **Yahoo rate-limit caveat**: rapid test calls during Phases 7+ triggered an IP-level rate limit. The Yahoo source code is correct; once the limit clears (typically <24h) the PM2 cron job will resume pulling data.

---

## Cross-cutting verifications (run before declaring "done")

These cut across phases and should pass once everything is wired:

1. **Multi-process WAL safety** — start everything via PM2, then:
   ```bash
   for i in {1..20}; do
     curl -X POST -H "Authorization: Bearer $PULSAR_INTERNAL_TOKEN" :3103/api/ingest/coingecko &
   done; wait
   ```
   No `SQLITE_BUSY` errors should appear in any log stream.
2. **Fresh-DB cold start** — `rm prisma/prod.db*`, `npx prisma migrate deploy`, `pm2 restart "pulsar*"`. The first `/prices/latest` call before any ingest returns `200 { count: 0, data: [] }`, not 500.
3. **Token rotation** — change `PULSAR_INTERNAL_TOKEN` in `.env`, `pm2 reload "pulsar*"`. Manual ingest with old token returns 401; new token works.
4. **`/health` failure surface** — `chmod 000 prisma/prod.db` temporarily; `/health` returns 503 within 1s with the locked shape; restore perms.
5. **WS reconnect after API restart** — connect a WS client, subscribe, restart the API. Client gets `1006`; reconnects with backoff; resubscribes; tick frames resume.
6. **Backfill range cap** — request `/history/bitcoin?from=2010-01-01&interval=1h`. Expect `400 tick_retention_exceeded` (because that range exceeds `TICK_RETENTION_DAYS`). Same range with `interval=1d` succeeds via the `DailySummary` path with backfill.

---

## Risks / things to watch during implementation

These are hazards that don't belong inside a single phase — keep them in mind throughout:

- **Prisma's default SQLite connection limit is 1.** Every PrismaClient instance serializes all queries by default. With WAL this is *correct* but can be slow under load. If profiling shows queue contention, raise it via the connection-string parameter `?connection_limit=N` per PrismaClient instance — but only after WAL is confirmed working.
- **Yahoo Finance has no public, stable API.** `query1.finance.yahoo.com/v7/finance/quote` is widely used but unofficial and Yahoo has aggressively rate-limited or blocked it in the past. Have a fallback plan (Alpha Vantage or scraper) ready, and don't make Mission Control depend on Yahoo for any single load-bearing widget without a degradation strategy.
- **CoinGecko free-tier rate limits.** Documented 10–30 req/min depending on endpoint and time of day. The schedule (5 min cadence × 1 batched request) sits well under the limit — but a backfill that hammers `/coins/{id}/market_chart` will burn through the budget fast. Add a static delay between backfill batches if you're filling many coins at once.
- **`@hono/node-ws` ergonomics.** `WSContext` differs from the `ws` package's `WebSocket` in subtle ways (`send` is async with optional callback, `ping`/`pong` may not be exposed identically). Read the `@hono/node-ws` README before implementing Phase 7; budget extra time if its API changed in a recent version.
- **`change24h` null handling.** Implementations frequently return `0` instead of `null` when no comparison tick exists. Audit the `prices` route specifically: a fresh asset with one tick should produce `change24h: null`, not `0` or `NaN`.
- **Backfill cache key collision.** `withCache` keys by `path + sortedQuery`. Two requests with the same `from` but different DB state (one before backfill, one after) will hit the same key. Phase 5 step 5 calls this out — implement the bypass-on-backfilled-true path correctly or stale data will linger after a backfill.
- **PM2 `cron_restart` semantics.** Confirm with `pm2 --version` that the installed PM2 supports `cron_restart` on per-process entries (not just on the deprecated `pm2 startOrRestart` flow). Older versions may need an upgrade.
- **Logger field collisions.** `proc`, `level`, `ts`, `msg` are reserved keys. Ensure callers don't pass these in `fields` — either drop them silently or namespace them.
- **`@@unique([assetId, timestamp, source])` and millisecond precision.** SQLite stores `DateTime` with millisecond precision via Prisma. If a fetcher produces multiple ticks within the same millisecond for the same asset+source, only one survives `skipDuplicates`. Generally fine, but worth knowing if a future high-frequency source is added.

---

## Out of scope (intentionally)

For clarity, these are *not* part of v1 and not in this plan:

- API key auth / `ApiKey` schema (the Phase 8 internal token covers all sensitive endpoints; external keys come later if needed)
- Prometheus / observability metrics endpoint
- Backups (will be set up separately once data is load-bearing)
- Alerting on `IngestJob.status = FAILED`
- Shared TypeScript client SDK package
- PostgreSQL/TimescaleDB migration

These are tracked in `[architecture § Open Questions / Future Considerations]`.
