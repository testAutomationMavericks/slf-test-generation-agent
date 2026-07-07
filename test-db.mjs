import postgres from 'postgres'

const url = process.argv[2]
if (!url) { console.error('Usage: node test-db.mjs <connection-url>'); process.exit(1) }

console.log('Testing:', url.replace(/:([^:@]+)@/, ':****@'), '\n')

const modes = [
  { label: 'SSL off',                  ssl: false },
  { label: 'SSL require',              ssl: 'require' },
  { label: 'SSL allow self-signed',    ssl: { rejectUnauthorized: false } },
]

for (const mode of modes) {
  process.stdout.write(`[${mode.label}] ... `)
  const sql = postgres(url, { ssl: mode.ssl, max: 1, connect_timeout: 8, idle_timeout: 3 })
  try {
    const [row] = await sql`SELECT version() AS v`
    console.log('✓ Connected!')
    console.log('  PostgreSQL:', row.v.split(' ').slice(0, 2).join(' '))
    console.log('\n  → Use DB_SSL setting:', JSON.stringify(mode.ssl))
    await sql.end()
    process.exit(0)
  } catch (e) {
    console.log('✗', e.message.split('\n')[0])
  } finally {
    await sql.end().catch(() => {})
  }
}

console.log('\nAll modes failed. Check credentials and that schema.sql has been applied.')
