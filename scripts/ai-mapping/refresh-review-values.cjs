// Refresh display metadata only; read-only database access, no model or channel writes.
require('dotenv').config({ quiet: true })
const fs = require('node:fs')
const { Client } = require('pg')
const { mappingLOVSamplesSQL, sampleDictionary } = require('../../src/channels/ai/values.ts')
const { renderReviewPage } = require('./retrieval-review-page.cjs')

async function main () {
  const database = process.env.OPENPIM_DATABASE_NAME || process.env.DATABASE_NAME
  if (database !== 'kuppersberg') throw Error('Expected the kuppersberg review database.')
  const files = ['embeddings-review-dataset.json', 'embeddings-diagnostic-cold.json', 'embeddings-diagnostic-warm.json']
  const documents = files.map(file => JSON.parse(fs.readFileSync('docs/ai-mapping/' + file, 'utf8')))
  const candidates = documents[0].cases.flatMap(row => row.candidates).filter(row => row.dictionary)
  const identifiers = [...new Set(candidates.map(row => row.attrIdent.replace(/#ru$/, '')))]
  const client = new Client({ host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432), database,
    user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD, connectionTimeoutMillis: 10000 })
  let samples
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout='15s'")
    const channels = (await client.query('SELECT "tenantId" FROM channels WHERE identifier=$1 AND type=9 AND "deletedAt" IS NULL', ['ym'])).rows
    if (channels.length !== 1) throw Error('Expected exactly one review channel.')
    const tenant = channels[0].tenantId
    const ids = (await client.query('SELECT DISTINCT lov FROM attributes WHERE "tenantId"=$1 AND "deletedAt" IS NULL AND identifier=ANY($2::text[]) AND type=7 AND lov>0', [tenant, identifiers])).rows.map(row => row.lov)
    samples = (await client.query(mappingLOVSamplesSQL, [tenant, ids, identifiers])).rows
    await client.query('ROLLBACK')
  } finally { await client.end() }
  const byIdentifier = new Map(samples.map(row => [row.attributeIdent, { ...sampleDictionary(row, 'ru'), attributeFiltered: true }]))
  for (const document of documents) for (const row of document.cases || document.rows) for (const candidate of row.candidates) {
    if (!candidate.dictionary) continue
    const sample = byIdentifier.get(candidate.attrIdent.replace(/#ru$/, ''))
    candidate.valueOptions = { ...(sample || { status: 'unavailable', examples: [], total: null, truncated: false }),
      sharedByAttributes: candidate.valueOptions?.sharedByAttributes || 0 }
  }
  const html = renderReviewPage(documents[2])
  const oldHTML = fs.readFileSync('docs/ai-mapping/embeddings-review.html', 'utf8')
  const checksum = text => text.match(/"checksum":"([a-f0-9]+)"/)[1]
  if (checksum(html) !== checksum(oldHTML)) throw Error('Display refresh would change the review draft key.')
  files.forEach((file, index) => fs.writeFileSync('docs/ai-mapping/' + file, JSON.stringify(documents[index], null, 2) + '\n'))
  fs.writeFileSync('docs/ai-mapping/embeddings-review.html', html)
  console.log(JSON.stringify({ attributesRefreshed: byIdentifier.size, draftKeyPreserved: true }))
}
main().catch(() => { console.error('Review value refresh failed; check database availability and expected review scope.'); process.exitCode = 1 })
