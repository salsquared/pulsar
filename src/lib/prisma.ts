import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

async function buildClient(): Promise<PrismaClient> {
  const client = new PrismaClient()
  // WAL mode is mandatory — multiple PM2 processes write to the same SQLite file.
  // All three PRAGMAs return a result row, so $queryRawUnsafe is required.
  // See architecture § SQLite write concurrency — WAL mode is mandatory.
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL')
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000')
  await client.$queryRawUnsafe('PRAGMA synchronous = NORMAL')
  return client
}

// Singleton promise so all importers share one connected client and the pragmas
// are guaranteed to have run before any query executes.
const prismaPromise: Promise<PrismaClient> =
  globalForPrisma.prisma
    ? Promise.resolve(globalForPrisma.prisma)
    : buildClient().then((c) => {
        globalForPrisma.prisma = c
        return c
      })

export const getPrisma = (): Promise<PrismaClient> => prismaPromise

// Convenience re-export for the common synchronous-looking await pattern:
//   const prisma = await getPrisma()
export default prismaPromise
