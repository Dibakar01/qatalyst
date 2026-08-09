import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

// Next dev reloads server modules on every edit; without this the pool is
// recreated each time and Postgres runs out of connections.
const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> }
const sql = (globalForDb.sql ??= postgres(process.env.DATABASE_URL, { max: 5 }))

export const db = drizzle(sql, { schema })
export { sql }
