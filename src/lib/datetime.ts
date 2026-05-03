// Prisma 6 stores DateTime in SQLite as INTEGER (Unix milliseconds), not as text.
// The "YYYY-MM-DD HH:MM:SS UTC" shown in Prisma's query event log is just display
// formatting — the actual SQL binding is an integer.
//
// Raw INSERTs against tables read by Prisma's ORM MUST bind timestamps as integer
// milliseconds. Storing ISO text strings makes ORM range queries silently return 0
// rows because SQLite type-coerces TEXT-vs-INTEGER comparisons to NULL.
export function toPrismaDateTime(d: Date): number {
  return d.getTime()
}
