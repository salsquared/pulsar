// PM2 entry point for scheduled ingest jobs.
// PM2 sets SOURCE_ID in the environment and uses cron_restart to re-run on schedule.
// STARTUP_DELAY_SECONDS is optional — staggers initial runs to prevent boot bursts.

const sourceId = process.env.SOURCE_ID
if (!sourceId) {
  process.stderr.write('SOURCE_ID env var is required\n')
  process.exit(1)
}

// Set PROC before importing logger so every log line is tagged with the source id.
process.env.PROC = sourceId

import { runIngest } from './pipeline.js'
import { logger } from '../lib/logger.js'
import prismaPromise from '../lib/prisma.js'

const delaySeconds = parseInt(process.env.STARTUP_DELAY_SECONDS ?? '0', 10)
if (delaySeconds > 0) {
  logger.info('startup delay', { delaySeconds })
  await new Promise((r) => setTimeout(r, delaySeconds * 1000))
}

const prisma = await prismaPromise

try {
  const result = await runIngest(sourceId)
  logger.info('run complete', result)
  process.exit(0)
} catch (err) {
  logger.error('run failed', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
} finally {
  await prisma.$disconnect()
}
