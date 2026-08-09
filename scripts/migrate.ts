import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
await migrate(drizzle(sql), { migrationsFolder: './db/migrations' })
await sql.end()
console.log('migrations applied')
