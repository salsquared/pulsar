import WebSocket from 'ws'

let phase = 'connecting'
let initialSession: string | null = null
let reconnectedSession: string | null = null

function connect() {
  const ws = new WebSocket('ws://localhost:4103/ws/prices')
  ws.on('open', () => { ws.send(JSON.stringify({ type: 'subscribe', assetIds: ['bitcoin'] })) })
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'welcome') {
      if (phase === 'connecting') {
        initialSession = msg.sessionId
        phase = 'connected'
        console.log(`[1] connected, sessionId=${initialSession}`)
      } else if (phase === 'reconnecting') {
        reconnectedSession = msg.sessionId
        phase = 'reconnected'
        console.log(`[3] reconnected, sessionId=${reconnectedSession}`)
        if (initialSession !== reconnectedSession) console.log('   ✓ new session id (server restarted)')
        ws.close()
        process.exit(0)
      }
    }
  })
  ws.on('close', () => {
    if (phase === 'connected') {
      phase = 'reconnecting'
      console.log('[2] socket closed (API restarted), reconnecting in 800ms...')
      setTimeout(connect, 800)
    }
  })
  ws.on('error', () => {
    // Expected during restart window
    if (phase === 'reconnecting') setTimeout(connect, 500)
  })
}

connect()
setTimeout(() => { console.error('timeout'); process.exit(1) }, 20_000)
