/**
 * src/kb/migrate.ts
 *
 * Migrates documents from Phase 1 (local JSON) to Phase 2 (pgvector).
 * Re-generates voyage-3 embeddings for every document during migration.
 *
 * Usage:
 *   npm run kb:migrate
 *
 * Requires DATABASE_URL and ANTHROPIC_API_KEY in .env
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { LocalKnowledgeBase } from '../local-kb/local-vector-db.js'
import { PgKnowledgeBase } from './pg-vector-db.js'

dotenv.config()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function migrate() {
  const dbUrl = process.env.DATABASE_URL
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!dbUrl) {
    console.error('✗ DATABASE_URL not set in .env')
    process.exit(1)
  }
  if (!apiKey) {
    console.error('✗ ANTHROPIC_API_KEY not set in .env (required for voyage-3 embeddings)')
    process.exit(1)
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  KB Migration: Local JSON → pgvector')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const local = new LocalKnowledgeBase(path.join(ROOT, 'local-kb-data'))
  const pg = new PgKnowledgeBase(dbUrl, apiKey)

  // Count local docs
  const localStats = local.getStats() as any
  const total = localStats.total ?? 0
  console.log(`  Local KB: ${total} documents found`)

  if (total === 0) {
    console.log('  Nothing to migrate. Run npm run kb:local:seed first.')
    process.exit(0)
  }

  // Retrieve all local docs
  console.log('  Fetching all documents from local KB...')
  const results = await local.retrieve('', { topK: 99999, minScore: 0 })
  console.log(`  Retrieved ${results.length} documents`)

  // Ask for confirmation
  console.log(`\n  This will:`)
  console.log(`    • Clear the pgvector KB`)
  console.log(`    • Re-embed ${results.length} documents with voyage-3`)
  console.log(`    • Insert into PostgreSQL`)
  console.log(`\n  Estimated cost: ~$${((results.length * 500) / 1_000_000 * 0.12).toFixed(4)} (voyage-3 @ $0.12/M tokens)`)
  console.log(`  Estimated time: ~${Math.ceil(results.length * 0.5)} seconds\n`)

  // Clear pgvector and migrate
  console.log('  Clearing pgvector KB...')
  await pg.clear()

  console.log('  Migrating documents...\n')
  let migrated = 0
  let failed = 0

  for (const result of results) {
    const id = result.metadata.id ?? `migrated:${migrated}`
    const source = (result.metadata.source ?? 'generated') as 'jira' | 'zephyr' | 'confluence' | 'generated'

    try {
      await pg.addDocument({
        id,
        source,
        content: result.content,
        metadata: {
          source: result.metadata.source ?? 'generated',
          jira_issue_key: result.metadata.jira_issue_key ?? '',
          jira_epic: result.metadata.jira_epic ?? '',
          feature_area: result.metadata.feature_area ?? '',
          component: result.metadata.component ?? '',
          approved_by: result.metadata.approved_by ?? '',
          project_key: result.metadata.project_key ?? '',
          ingested_at: result.metadata.ingested_at ?? new Date().toISOString(),
          doc_type: result.metadata.doc_type ?? 'test_case',
        },
      })
      migrated++
      process.stdout.write(`  [${migrated}/${results.length}] ✓ ${id.slice(0, 50)}\n`)
    } catch (e) {
      failed++
      console.error(`  [${migrated + failed}/${results.length}] ✗ ${id}: ${e}`)
    }
  }

  const pgStats = await pg.getStats() as any
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Migration complete`)
  console.log(`  ✓ ${migrated} documents migrated`)
  if (failed > 0) console.log(`  ✗ ${failed} documents failed`)
  console.log(`  pgvector KB now has ${pgStats.total} documents`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  // Post-migration duplicate scan: flag near-duplicates for manual review.
  // Does not auto-delete and does not post Jira comments (batch operation).
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Post-migration duplicate scan')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  console.log('  Scanning migrated entries for near-duplicates...')
  console.log('  (flags for review only — no auto-deletion, no Jira comments)\n')

  const scanResult = await pg.scanAndFlagDuplicates(0.90)
  console.log(`  Scanned:  ${scanResult.scanned} entries`)
  console.log(`  Flagged:  ${scanResult.flagged} probable duplicates`)
  if (scanResult.flagged > 0) {
    console.log('  Review:   npm run kb → View outdated / stale entries')
  } else {
    console.log('  ✓ No duplicates found')
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  await pg.disconnect()
}

migrate().catch(e => {
  console.error('Migration failed:', e)
  process.exit(1)
})
