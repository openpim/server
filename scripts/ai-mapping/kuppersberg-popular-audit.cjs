// Independent SELECT-only validation and candidate-pool audit of the completed trial.
require('dotenv').config()
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { Client } = require('pg')
const { loadSnapshot } = require('./kuppersberg-evaluate.cjs')
const { selectCandidateGroups } = require('./sandbox-data.cjs')
const { createMappingVisibilityFilter } = require('../../src/channels/ai/mapping.ts')
const { mappingVisibilityPathsSQL, mappingVisibilityTargetsSQL } = require('../../src/channels/ai/visibility.ts')

async function main () {
  const specific = process.argv.includes('--specific')
  const file = specific ? 'docs/ai-mapping/kuppersberg-specific-evaluation.json' : 'docs/ai-mapping/kuppersberg-popular-filtered-evaluation.json'
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const baseline = JSON.parse(fs.readFileSync('docs/ai-mapping/kuppersberg-popular-evaluation.json', 'utf8'))
  const { channel, groups } = await loadSnapshot()
  const candidates = selectCandidateGroups(groups, 'mainAttrGroup')
  assert.equal(report.originalMappingsUnchanged, true)
  assert.equal(report.categories.length, 3)
  const db = new Client({ host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432), database: 'kuppersberg',
    user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD, connectionTimeoutMillis: 10000 })
  try {
    await db.connect()
    await db.query('BEGIN READ ONLY')
    await db.query("SET LOCAL statement_timeout='15s'")
    for (const category of report.categories) {
      const cat = channel.mappings[category.id]
      const roots = cat.visible.map(Number)
      const relationId = Number(cat.visibleRelation)
      const paths = (await db.query(mappingVisibilityPathsSQL, [channel.tenantId, roots, relationId])).rows.map(row => row.path)
      const targetPaths = (await db.query(mappingVisibilityTargetsSQL, [channel.tenantId, roots, relationId])).rows.map(row => row.path)
      const valid = (cat.valid?.length ? cat.valid : channel.valid).map(String)
      const pool = candidates.filter(group => group.visible).flatMap(group => group.attributes)
        .filter(attr => attr.identifier && attr.valid?.length && (!valid.length || attr.valid.some(type => valid.includes(String(type)))))
      const beforeFilter = createMappingVisibilityFilter({ paths, relationId })
      const afterFilter = createMappingVisibilityFilter({ paths, targetPaths, relationId })
      const before = new Set(pool.filter(beforeFilter).map(attr => attr.identifier))
      const after = new Set(pool.filter(afterFilter).map(attr => attr.identifier))
      category.poolAudit = { sourcePaths: paths.length, targetPaths: targetPaths.length,
        eligibleBeforeTargetVisibility: before.size, eligibleAfterTargetVisibility: after.size,
        excludedIdentifiers: [...before].filter(id => !after.has(id)) }
      assert.equal(category.runs.length, 2)
      const old = baseline.categories.find(row => row.id === category.id)
      for (const run of category.runs) {
        assert.equal(run.rows.length, category.selected)
        assert.equal(new Set(run.rows.map(row => specific ? row.id : row.attribute.id)).size, category.selected)
        for (const row of run.rows) {
          const request = specific ? category.requests.find(request => request.attribute.id === row.id) : row
          assert.ok(request)
          if (specific) {
            assert.ok(!old.runs[0].rows.some(previous => previous.attribute.id === row.id))
            assert.equal(row.name, request.attribute.name)
          } else assert.deepEqual(row.attribute, old.runs[0].rows.find(previous => previous.attribute.id === row.attribute.id).attribute)
          assert.equal(row.reference, cat.attributes.find(attr => attr.id === request.attribute.id).attrIdent || null)
          for (const candidate of request.candidates) assert.ok(after.has(candidate.attrIdent.split('#')[0]))
          if (row.suggestion.attrIdent) assert.ok(request.candidates.some(candidate => candidate.attrIdent === row.suggestion.attrIdent))
        }
      }
      console.log(JSON.stringify({ category: category.id, before: before.size, after: after.size,
        proposals: category.runs.map(run => run.proposed), repeatSame: category.repeatSame,
        repeatSameNonNull: category.repeatSameNonNull }))
    }
    await db.query('ROLLBACK')
  } finally { await db.end() }
  report.verification = { date: new Date().toISOString(), fixedMarketplaceContext: !specific, noOverlapWithPreviousRows: specific, candidateGroupAndVisibilityVerified: true,
    savedReferencesUnchanged: true, suggestionsWithinShortlists: true, completeRuns: 6, databaseWrites: 0 }
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
}
main().catch(error => { console.error('Popular audit failed (' + (error.code || 'validation') + '). No database writes.'); process.exitCode = 1 })
