// Additional category-specific characteristics. SELECT-only, no saved mapping changes.
require('dotenv').config()
const fs = require('node:fs')
const { Client } = require('pg')
const { loadSnapshot, loadYandexAttributes } = require('./kuppersberg-evaluate.cjs')
const { selectCandidateGroups } = require('./sandbox-data.cjs')
const { selectSpecificAttributes } = require('./specific-selection.cjs')
const { readMappingConfig, buildMappingRequests, suggestMappings, createMappingVisibilityFilter } = require('../../src/channels/ai/mapping.ts')
const { enrichMappingRequests, mappingLOVSamplesSQL } = require('../../src/channels/ai/values.ts')
const { mappingVisibilityPathsSQL, mappingVisibilityTargetsSQL } = require('../../src/channels/ai/visibility.ts')
const metadataOnly = process.argv.includes('--metadata-only')
const output = 'docs/ai-mapping/kuppersberg-specific-' + (metadataOnly ? 'metadata' : 'evaluation') + '.json'

function connection () {
  return new Client({ host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432), database: 'kuppersberg',
    user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD, connectionTimeoutMillis: 10000 })
}
async function main () {
  const config = readMappingConfig()
  if (!metadataOnly && (!config.enabled || config.baseUrl !== 'https://ollama.com/v1' || config.model !== 'deepseek-v4.1-flash')) throw Error('Unexpected provider')
  const baseline = JSON.parse(fs.readFileSync('docs/ai-mapping/kuppersberg-popular-filtered-evaluation.json', 'utf8'))
  const { channel, groups } = await loadSnapshot()
  const original = JSON.stringify(channel.mappings)
  const candidates = selectCandidateGroups(groups, 'mainAttrGroup')
  const report = { date: new Date().toISOString(), database: 'kuppersberg', channel: 'ym', group: 'mainAttrGroup',
    model: config.model, readOnly: true, metadataOnly, methodology: 'Up to 15 eligible required/category-specific live characteristics per category, excluding all ten previously tested IDs. Required first, then round-robin across predefined category themes. Two identical-context model runs. Existing mappings are local references, not gold labels.',
    categories: [] }
  for (const previous of baseline.categories) {
    const category = channel.mappings[previous.id]
    if (!category || category.deleted || String(category.id) !== previous.id) throw Error('Category changed')
    const live = await loadYandexAttributes(previous.id, channel.config.apiToken, config)
    const previousIds = previous.runs[0].rows.map(row => row.attribute.id)
    const selected = selectSpecificAttributes(previous.id, live, category.attributes, previousIds)
    if (!selected.length) throw Error('No eligible specific characteristics')
    const db = connection()
    let requests, poolCount
    try {
      await db.connect()
      await db.query('BEGIN READ ONLY')
      await db.query("SET LOCAL statement_timeout='15s'")
      const roots = category.visible.map(Number)
      const relationId = category.visibleRelation == null ? null : Number(category.visibleRelation)
      const paths = (await db.query(mappingVisibilityPathsSQL, [channel.tenantId, roots, relationId])).rows.map(row => row.path)
      const targetPaths = relationId === null ? [] : (await db.query(mappingVisibilityTargetsSQL, [channel.tenantId, roots, relationId])).rows.map(row => row.path)
      if (roots.some(id => !paths.some(path => path.split('.').pop() === String(id)))) throw Error('Missing roots')
      const valid = category.valid?.length ? category.valid : channel.valid || []
      const visibility = { paths, targetPaths, relationId }
      poolCount = new Set(candidates.filter(group => group.visible).flatMap(group => group.attributes)
        .filter(attr => attr.identifier && attr.valid?.length && (!valid.length || attr.valid.some(type => valid.map(String).includes(String(type)))))
        .filter(createMappingVisibilityFilter(visibility)).map(attr => attr.identifier)).size
      requests = await enrichMappingRequests(buildMappingRequests(candidates, selected, 'ru', valid, visibility), candidates, selected, 'ru', channel.tenantId,
        async (ids, tenantId) => (await db.query(mappingLOVSamplesSQL, [tenantId, ids])).rows)
      await db.query('ROLLBACK')
    } finally { await db.end() }
    const result = { id: previous.id, name: previous.name, products: previous.products, liveAttributes: live.length,
      requiredLive: live.filter(attr => attr.required).length, requiredSelected: selected.filter(attr => attr.required).length,
      selected: selected.length, poolCount, requests, runs: [] }
    report.categories.push(result)
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ category: previous.id, selected: selected.map(attr => attr.name), requiredLive: result.requiredLive, requiredSelected: result.requiredSelected, poolCount }))
    if (metadataOnly) continue
    for (let run = 1; run <= 2; run++) {
      const started = Date.now()
      const suggestions = await suggestMappings(requests, config, { category: typeof category.name === 'string' ? category.name : category.name.ru, language: 'ru' })
      const rows = requests.map(request => {
        const reference = category.attributes.find(row => row.id === request.attribute.id).attrIdent || null
        return { id: request.attribute.id, name: request.attribute.name, reference,
          referenceInShortlist: reference ? request.candidates.some(row => row.attrIdent === reference) : null,
          suggestion: suggestions.find(row => row.id === request.attribute.id), humanVerdict: 'pending' }
      })
      result.runs.push({ run, elapsedMs: Date.now() - started, proposed: suggestions.filter(row => row.attrIdent).length, rows })
      if (run === 2) {
        result.repeatSame = rows.filter(row => row.suggestion.attrIdent === result.runs[0].rows.find(old => old.id === row.id).suggestion.attrIdent).length
        result.repeatSameNonNull = rows.filter(row => row.suggestion.attrIdent && row.suggestion.attrIdent === result.runs[0].rows.find(old => old.id === row.id).suggestion.attrIdent).length
      }
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
      console.log(JSON.stringify({ category: previous.id, run, selected: rows.length, proposed: result.runs.at(-1).proposed,
        elapsedMs: result.runs.at(-1).elapsedMs, repeatSame: result.repeatSame }))
    }
  }
  report.originalMappingsUnchanged = JSON.stringify((await loadSnapshot()).channel.mappings) === original
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  if (!report.originalMappingsUnchanged) throw Error('Original mappings changed concurrently')
}
main().catch(error => { console.error('Specific trial failed (' + (error.code || 'request-or-validation') + '). No database writes.'); process.exitCode = 1 })
