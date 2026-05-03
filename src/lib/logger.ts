type Level = 'info' | 'warn' | 'error'

function log(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    proc: process.env.PROC ?? 'unknown',
    msg,
    ...fields,
  })
  if (level === 'error') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

export const logger = {
  info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, fields),
}
