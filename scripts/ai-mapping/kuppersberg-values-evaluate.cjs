// Read-only operator trial, no channel creation or saved mapping changes.
require('dotenv').config()
const fs = require('node:fs')
const { Client } = require('pg')
const { loadSnapshot, loadYandexAttributes } = require('./kuppersberg-evaluate.cjs')
const { readMappingConfig, buildMappingRequests, suggestMappings } = require('../../src/channels/ai/mapping.ts')
const { enrichMappingRequests, mappingLOVSamplesSQL } = require('../../src/channels/ai/values.ts')
const { mappingVisibilityPathsSQL, mappingVisibilityTargetsSQL } = require('../../src/channels/ai/visibility.ts')

async function main () {
  const config = readMappingConfig()
  if (!config.enabled || config.baseUrl !== 'https://ollama.com/v1' || config.model !== 'deepseek-v4.1-flash') throw Error('Expected authorized provider')
  const { channel, groups } = await loadSnapshot()
  const categoryId = '15450095'
  const category = channel.mappings[categoryId]
  const baseline = JSON.parse(fs.readFileSync('docs/ai-mapping/kuppersberg-wine-sandbox-1c-evaluation.json', 'utf8'))
  const names = ['Количество температурных зон', 'Класс энергопотребления', 'Тип управления', 'Тип компрессора', 'Материал полок']
  const ids = names.map(name => {
    const row = baseline.runs[0].rows.find(row => row.name === name)
    if (!row) throw Error('Missing baseline row')
    return row.id
  })
  const attributes = (await loadYandexAttributes(categoryId, channel.config.apiToken, config)).filter(row => ids.includes(row.id))
  if (attributes.length !== 5) throw Error('Expected five live attributes')
  const candidates = groups.filter(group => group.identifier === 'mainAttrGroup')
  if (candidates.length !== 1) throw Error('Expected exact 1C group')
  const client = new Client({ host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432), database: 'kuppersberg',
    user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD, connectionTimeoutMillis: 10000 })
  let requests
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout='10s'")
    const paths = (await client.query(mappingVisibilityPathsSQL, [channel.tenantId, category.visible.map(Number), Number(category.visibleRelation)])).rows.map(row => row.path)
    const targetPaths = (await client.query(mappingVisibilityTargetsSQL, [channel.tenantId, category.visible.map(Number), Number(category.visibleRelation)])).rows.map(row => row.path)
    if (!category.visible.every(id => paths.some(path => path.split('.').pop() === String(id)))) throw Error('Missing visibility roots')
    const base = buildMappingRequests(candidates, attributes, 'ru', category.valid?.length ? category.valid : channel.valid,
      { paths, targetPaths, relationId: Number(category.visibleRelation) })
    requests = await enrichMappingRequests(base, candidates, attributes, 'ru', channel.tenantId,
      async (ids, tenantId, identifiers) => (await client.query(mappingLOVSamplesSQL, [tenantId, ids, identifiers])).rows)
    await client.query('ROLLBACK')
  } finally { await client.end() }
  const started = Date.now()
  const suggestions = await suggestMappings(requests, config, { category: category.name, language: 'ru' })
  const report = { date: new Date().toISOString(), categoryId, group: 'mainAttrGroup', model: config.model,
    readOnly: true, elapsedMs: Date.now() - started,
    methodology: 'Five dictionary attributes; values and explicit PIM types added together. Baseline was a different batch composition. This is a context delivery trial, not an isolated measurement of dictionary improvement.',
    rows: requests.map(request => {
      const old = baseline.runs[0].rows.find(row => row.id === request.attribute.id)
      const suggestion = suggestions.find(row => row.id === request.attribute.id)
      return { ...request, suggestion, baselineSuggestion: old.suggestion, humanVerdict: 'pending' }
    }) }
  fs.writeFileSync('docs/ai-mapping/kuppersberg-values-evaluation.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ selected: requests.length, elapsedMs: report.elapsedMs,
    marketplaceDictionariesLoaded: requests.filter(row => row.attribute.valueOptions?.status === 'loaded').length,
    PIMSamplesLoaded: requests.reduce((sum, row) => sum + row.candidates.filter(candidate => candidate.valueOptions?.status === 'loaded').length, 0),
    proposed: suggestions.filter(row => row.attrIdent).length, databaseWrites: 0 }))
}
main().catch(error => { console.error('Dictionary trial failed (' + (error.code || 'request-or-validation') + '). No database writes.'); process.exitCode = 1 })
