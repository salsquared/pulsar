// Insert backdated bitcoin ticks across the last 7 days for rollup verification.
import prismaPromise from '../src/lib/prisma.js'
import { toPrismaDateTime } from '../src/lib/datetime.js'

const prisma = await prismaPromise

const DAYS = 7
const TICKS_PER_DAY = 12  // every 2 hours
const now = Date.now()
const todayMid = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())

const rows: Array<[string, number, number | null, number | null, number | null, number, number | null, string]> = []
for (let d = 1; d <= DAYS; d++) {
  const dayStart = todayMid - d * 86_400_000
  for (let h = 0; h < TICKS_PER_DAY; h++) {
    const ts = dayStart + h * (86_400_000 / TICKS_PER_DAY)
    const close = 80000 + d * 100 + h * 10  // some variance
    const high = close + 50
    const low = close - 50
    const volume = 1000 + h * 100
    rows.push(['bitcoin', ts, null, high, low, close, volume, 'coingecko'])
  }
}

const ph = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
const vals = rows.flat()
await prisma.$executeRawUnsafe(
  `INSERT OR IGNORE INTO "PriceTick" ("assetId","timestamp","open","high","low","close","volume","source") VALUES ${ph}`,
  ...vals,
)
console.log(`inserted ${rows.length} backdated ticks`)
await prisma.$disconnect()
