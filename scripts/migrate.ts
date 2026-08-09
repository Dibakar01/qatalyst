import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { migrate } from 'drizzle-orm/neon-http/migrator'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

await migrate(drizzle(neon(process.env.DATABASE_URL)), { migrationsFolder: './db/migrations' })
console.log('migrations applied')
