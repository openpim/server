// Local operator tool: reads metadata in a read-only transaction; never saves mappings.
require('dotenv').config()
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const fetch = require('node-fetch')
const { readMappingConfig, buildMappingRequests, suggestMappings, createMappingVisibilityFilter } = require('../../src/channels/ai/mapping.ts')
const { mappingVisibilityPathsSQL, mappingVisibilityTargetsSQL } = require('../../src/channels/ai/visibility.ts')
const { createMappingHTTPSAgent } = require('../../src/channels/ai/provider.ts')

const channelIdentifier = 'ym'
const categoryIds = ['90601', '15450095', '61377314']
const metadataOnly = process.argv.includes('--metadata-only')
const repeatFirst = process.argv.includes('--repeat-first')
const useVisibility = process.argv.includes('--visibility')
const filename = useVisibility ? (metadataOnly ? 'kuppersberg-visibility-metadata.json' : repeatFirst ? 'kuppersberg-visibility-evaluation-repeat.json' : 'kuppersberg-visibility-evaluation.json')
  : metadataOnly ? 'kuppersberg-metadata.json' : repeatFirst ? 'kuppersberg-evaluation-repeat.json' : 'kuppersberg-evaluation.json'
const output = path.resolve(__dirname, '../../docs/ai-mapping/' + filename)

async function loadSnapshot () {
  const database = process.env.OPENPIM_DATABASE_NAME || process.env.DATABASE_NAME
  if (database !== 'kuppersberg') throw new Error('This evaluation requires the kuppersberg database.')
  const client = new Client({
    host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432),
    database,
    user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD,
    connectionTimeoutMillis: 10000
  })
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '15s'")
    const channels = await client.query('SELECT id, "tenantId", identifier, type, valid, mappings, config FROM channels WHERE identifier=$1 AND "deletedAt" IS NULL', [channelIdentifier])
    if (channels.rows.length !== 1 || channels.rows[0].type !== 9) throw new Error('Expected one Yandex Market channel named ym.')
    const channel = channels.rows[0]
    const rows = await client.query(`SELECT g.id AS "groupId", g.identifier AS "groupIdentifier", g.name AS "groupName", g.visible AS "groupVisible",
      a.identifier, a.name, a.type, a.valid, a."languageDependent", a.lov, a.visible, a.relations, a.options
      FROM "attrGroups" g JOIN group_attribute ga ON ga."AttrGroupId"=g.id
      JOIN attributes a ON a.id=ga."AttributeId"
      WHERE g."tenantId"=$1 AND a."tenantId"=$1 AND g."deletedAt" IS NULL AND a."deletedAt" IS NULL
      ORDER BY g.id, a.id`, [channel.tenantId])
    const groups = new Map()
    for (const row of rows.rows) {
      if (!groups.has(row.groupId)) groups.set(row.groupId, { id: row.groupId, identifier: row.groupIdentifier, name: row.groupName, visible: row.groupVisible, attributes: [] })
      groups.get(row.groupId).attributes.push({ identifier: row.identifier, name: row.name, type: row.type,
        valid: row.valid, languageDependent: row.languageDependent, lov: row.lov, visible: row.visible, relations: row.relations, options: row.options })
    }
    const pathsByCategory = new Map()
    const targetPathsByCategory = new Map()
    if (useVisibility) for (const id of categoryIds) {
      const category = channel.mappings[id]
      const ids = [...new Set((category?.visible || []).map(String))]
      if (!ids.length) continue
      const paths = await client.query(mappingVisibilityPathsSQL, [channel.tenantId, ids, category.visibleRelation == null ? null : Number(category.visibleRelation)])
      pathsByCategory.set(id, paths.rows.map(row => row.path))
      const relationId = category.visibleRelation == null ? null : Number(category.visibleRelation)
      if (relationId !== null) {
        const targets = await client.query(mappingVisibilityTargetsSQL, [channel.tenantId, ids, relationId])
        targetPathsByCategory.set(id, targets.rows.map(row => row.path))
      }
    }
    await client.query('ROLLBACK')
    return { channel, groups: [...groups.values()], pathsByCategory, targetPathsByCategory }
  } finally { await client.end() }
}

async function loadYandexAttributes (categoryId, apiToken, config) {
  const agent = createMappingHTTPSAgent(config.useSystemCA)
  try {
    const response = await fetch(`https://api.partner.market.yandex.ru/v2/category/${categoryId}/parameters`, {
      method: 'POST', redirect: 'error', timeout: 30000, size: 4 * 1024 * 1024, agent,
      headers: { 'Content-Type': 'application/json', 'Api-Key': apiToken }
    })
    if (!response.ok) throw new Error('Yandex metadata returned HTTP ' + response.status)
    const json = await response.json()
    if (!json.result?.parameters) throw new Error('Yandex metadata has no parameters.')
    // Match the production handler's descriptive fields, excluding credential-bearing links.
    const typeNames = { ENUM: 'List of values', TEXT: 'Text', NUMERIC: 'Number', BOOLEAN: 'Boolean' }
    return Object.values(json.result.parameters).map(parameter => {
      const unit = parameter.unit?.defaultUnitId ? parameter.unit.units?.find(value => value.id === parameter.unit.defaultUnitId) : null
      return { id: 'yandexattr_' + parameter.id,
        name: parameter.name + (unit ? ', ' + unit.name : '') + (parameter.type !== 'ENUM' ? ' (' + typeNames[parameter.type] + ')' : ''),
        description: parameter.description + '\n id: ' + parameter.id + ', category: ' + categoryId, required: !!parameter.required,
        dictionary: parameter.type === 'ENUM', type: parameter.type, isNumber: parameter.type === 'NUMERIC',
        unit: unit?.name, dictionaryValues: parameter.type === 'ENUM' && Array.isArray(parameter.values) ? parameter.values : undefined }
    })
  } finally { agent?.destroy() }
}

async function main () {
  const config = readMappingConfig()
  if (!metadataOnly && !config.enabled) throw new Error('AI mapping is disabled.')
  const { channel, groups, pathsByCategory, targetPathsByCategory } = await loadSnapshot()
  if (!channel.config.apiToken) throw new Error('Yandex metadata token is missing.')
  const report = { date: new Date().toISOString(), database: 'kuppersberg', channel: channelIdentifier,
    mode: metadataOnly ? 'metadata-only; no LLM request' : 'LLM evaluation',
    visibilityFilter: useVisibility,
    visibilityAlgorithm: useVisibility ? 'catalog subtrees plus incoming sources of selected products; preserve unknown relation domains and standard product attributes' : null,
    channelId: channel.id, tenant: channel.tenantId, model: config.model,
    timeoutMs: config.timeoutMs, batchSize: config.batchSize,
    methodology: 'Up to 5 existing direct mappings plus up to 5 empty rows per category. Existing mappings are a reference, not a manually validated gold standard. No mappings are saved.',
    categories: [] }
  for (const categoryId of repeatFirst ? categoryIds.slice(0, 1) : categoryIds) {
    const category = channel.mappings[categoryId]
    if (!category || category.deleted || String(category.id) !== categoryId || !Array.isArray(category.attributes)) throw new Error('Evaluation category is missing or changed: ' + categoryId)
    const live = await loadYandexAttributes(categoryId, channel.config.apiToken, config)
    const liveIds = new Set(live.map(attribute => attribute.id))
    const counts = new Map()
    for (const row of category.attributes) counts.set(row.id, (counts.get(row.id) || 0) + 1)
    const eligible = category.attributes.filter(row => liveIds.has(row.id) && counts.get(row.id) === 1 && !row.expr && !String(row.id).startsWith('#'))
    const selected = [...eligible.filter(row => row.attrIdent).slice(0, 5), ...eligible.filter(row => !row.attrIdent).slice(0, 5)]
    const selectedIds = new Set(selected.map(row => row.id))
    const valid = category.valid?.length ? category.valid : channel.valid
    const visibleIds = (category.visible || []).map(String)
    const paths = pathsByCategory.get(categoryId) || []
    if (useVisibility && visibleIds.some(id => !paths.some(path => path.split('.').pop() === id))) throw new Error('Category visibility paths are unavailable.')
    const visibility = useVisibility && visibleIds.length ? { paths, targetPaths: targetPathsByCategory.get(categoryId), relationId: category.visibleRelation == null ? null : Number(category.visibleRelation) } : undefined
    const eligibleCandidates = groups.filter(group => group.visible).flatMap(group => group.attributes)
      .filter(attribute => attribute.valid?.length && (!valid.length || attribute.valid.some(type => valid.map(String).includes(String(type)))))
    const poolBefore = new Set(eligibleCandidates.map(attribute => attribute.identifier)).size
    const poolAfter = new Set(eligibleCandidates.filter(createMappingVisibilityFilter(visibility)).map(attribute => attribute.identifier)).size
    const requests = buildMappingRequests(groups, live.filter(attribute => selectedIds.has(attribute.id)), 'ru', valid, visibility)
    const started = Date.now()
    const categoryName = typeof category.name === 'string' ? category.name : category.name?.ru
    const suggestions = metadataOnly
      ? requests.map(request => ({ id: request.attribute.id, attrIdent: null, needsReview: true, reason: 'LLM not called.' }))
      : await suggestMappings(requests, config, { category: String(categoryName || categoryId).slice(0, 500), language: 'ru' })
    const rows = suggestions.map(suggestion => {
      const request = requests.find(row => row.attribute.id === suggestion.id)
      const existing = selected.find(row => row.id === suggestion.id)?.attrIdent || null
      return { id: suggestion.id, name: request.attribute.name, numeric: request.attribute.numeric,
        dictionary: request.attribute.dictionary, reference: existing,
        referenceInShortlist: existing ? request.candidates.some(candidate => candidate.attrIdent === existing) : null,
        candidates: request.candidates.map(candidate => ({ attrIdent: candidate.attrIdent, name: candidate.name })),
        suggestion: suggestion.attrIdent, needsReview: suggestion.needsReview, reason: suggestion.reason,
        agreesWithReference: existing && !metadataOnly ? existing === suggestion.attrIdent : null,
        humanVerdict: 'pending' }
    })
    const result = { id: categoryId, name: category.name, liveAttributes: live.length,
      poolBefore, poolAfter,
      selected: rows.length, elapsedMs: Date.now() - started,
      referenceCount: rows.filter(row => row.reference).length,
      referenceInShortlist: rows.filter(row => row.referenceInShortlist).length,
      agreesWithReference: rows.filter(row => row.agreesWithReference).length,
      proposed: rows.filter(row => row.suggestion).length, rows }
    report.categories.push(result)
    // Store completed categories locally even if a later external request fails.
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ category: categoryId, selected: result.selected, elapsedMs: result.elapsedMs,
      referenceCount: result.referenceCount, referenceInShortlist: result.referenceInShortlist,
      agreesWithReference: result.agreesWithReference, proposed: result.proposed, poolBefore, poolAfter }))
  }
  console.log('Report: ' + path.relative(process.cwd(), output))
}

module.exports = { loadSnapshot, loadYandexAttributes }

if (require.main === module) main().catch(error => {
  // Do not expose connection strings, provider response bodies or channel configuration.
  console.error('Evaluation failed (' + (error.code || error.type || 'request-or-validation') + '). No database writes were performed.')
  process.exitCode = 1
})
