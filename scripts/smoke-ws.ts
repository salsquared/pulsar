// Quick smoke test: connect to WS, subscribe to bitcoin, trigger a coingecko ingest,
// verify a tick frame arrives.
// Usage: npx tsx scripts/smoke-ws.ts
import { execSync } from 'node:child_process'
import WebSocket from 'ws'

const ws = new WebSocket('ws://localhost:4103/ws/prices')
let tickReceived = false

ws.on('open', () => {
  console.log('[ws] connected')
  ws.send(JSON.stringify({ type: 'subscribe', assetIds: ['bitcoin'] }))
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log('[ws] <--', JSON.stringify(msg))
  if (msg.type === 'tick') {
    tickReceived = true
    ws.close()
  }
})

ws.on('close', () => {
  if (tickReceived) {
    console.log('\n✓ WS smoke test passed — tick frame received')
    process.exit(0)
  } else {
    console.error('\n✗ WS smoke test failed — no tick received')
    process.exit(1)
  }
})

ws.on('error', (err) => {
  console.error('[ws] error', err.message)
  process.exit(1)
})

// Give welcome + subscribed time, then trigger an ingest
setTimeout(() => {
  console.log('[test] triggering coingecko ingest...')
  try {
    execSync(
      'node --env-file .env.development --import tsx/esm src/ingest/run.ts',
      { env: { ...process.env, SOURCE_ID: 'coingecko' }, stdio: 'pipe', timeout: 20_000 },
    )
  } catch (err) {
    console.error('[test] ingest failed:', (err as Error).message)
  }
}, 1000)

setTimeout(() => {
  console.error('\n✗ timeout — no tick in 30s')
  ws.close()
  process.exit(1)
}, 30_000)
