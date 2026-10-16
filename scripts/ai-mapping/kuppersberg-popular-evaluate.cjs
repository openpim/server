// Operator evaluation: SELECT-only transactions; model receives metadata, never product values.
require('dotenv').config()
const fs = require('node:fs')
const { Client } = require('pg')
const { loadSnapshot, loadYandexAttributes } = require('./kuppersberg-evaluate.cjs')
const { selectCandidateGroups } = require('./sandbox-data.cjs')
const { readMappingConfig, buildMappingRequests, suggestMappings } = require('../../src/channels/ai/mapping.ts')
const { enrichMappingRequests, mappingLOVSamplesSQL } = require('../../src/channels/ai/values.ts')
const { mappingVisibilityPathsSQL, mappingVisibilityTargetsSQL } = require('../../src/channels/ai/visibility.ts')

const compareVisibility = process.argv.includes('--compare-visibility')
const baselineFile = 'docs/ai-mapping/kuppersberg-popular-evaluation.json'
const baseline = compareVisibility ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null
const output = compareVisibility ? 'docs/ai-mapping/kuppersberg-popular-filtered-evaluation.json' : baselineFile
const metadataOnly = process.argv.includes('--metadata-only')
function connection () {
  return new Client({ host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432),
    database: 'kuppersberg', user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD,
    connectionTimeoutMillis: 10000 })
}
async function main () {
  const config = readMappingConfig()
  if (!metadataOnly && (!config.enabled || config.baseUrl !== 'https://ollama.com/v1' || config.model !== 'deepseek-v4.1-flash')) throw Error('Unexpected provider')
  const { channel, groups } = await loadSnapshot()
  const candidates = selectCandidateGroups(groups, 'mainAttrGroup')
  const original = JSON.stringify(channel.mappings)
  const report = { date: new Date().toISOString(), database: 'kuppersberg', channel: 'ym', group: 'mainAttrGroup',
    readOnly: true, model: config.model, metadataOnly, selection: 'Top 3 configured categories by count of distinct matching PIM products; top 10 eligible live characteristics per category, ordered by frequency of direct mappings across configured categories then required flag. Counts describe catalog usage, not sales or populated values.',
    fixedInputComparedWithBaseline: compareVisibility,
    limitations: ['Existing mappings are references, not human-validated truth.', 'Unrelated relation domains and categories without target products retain uncertain candidates.', 'Expression-based category selection is not executed.', 'Shared LOV examples do not define a specific attribute domain.'],
    ranking: [], characteristicFrequency: [], categories: [] }
  const frequencies = new Map()
  const cats = Object.entries(channel.mappings).filter(([id, cat]) => /^\d+$/.test(id) && !cat.deleted && String(cat.id) === id && Array.isArray(cat.attributes))
  for (const [, cat] of cats) for (const id of new Set(cat.attributes.filter(row => row.attrIdent && !row.expr && String(row.id).startsWith('yandexattr_')).map(row => row.id))) frequencies.set(id, (frequencies.get(id) || 0) + 1)
  const client = connection()
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout='15s'")
    for (const [id, cat] of cats) {
      const valid = (cat.valid?.length ? cat.valid : channel.valid || []).map(Number)
      const roots = (cat.visible || []).map(Number)
      let count = null
      let selectionMode = 'unsupported-expression-or-missing-visibility'
      if (roots.length && valid.length) {
        const sql = cat.visibleRelation
          ? `SELECT count(DISTINCT target.id)::integer AS count FROM items target
             JOIN "itemRelations" rel ON rel."targetId"=target.id AND rel."tenantId"=$1 AND rel."deletedAt" IS NULL AND rel."relationId"=$4
             JOIN items source ON source.id=rel."itemId" AND source."tenantId"=$1 AND source."deletedAt" IS NULL
             WHERE target."tenantId"=$1 AND target."deletedAt" IS NULL AND target."typeId"=ANY($3::integer[])
             AND replace(source.identifier,'ymcat_','')=$5
             AND source.path <@ ANY(ARRAY(SELECT path FROM items WHERE "tenantId"=$1 AND "deletedAt" IS NULL AND id=ANY($2::integer[])))`
          : `SELECT count(*)::integer AS count FROM items WHERE "tenantId"=$1 AND "deletedAt" IS NULL AND "typeId"=ANY($3::integer[])
             AND path <@ ANY(ARRAY(SELECT path FROM items WHERE "tenantId"=$1 AND "deletedAt" IS NULL AND id=ANY($2::integer[])))`
        const params = cat.visibleRelation ? [channel.tenantId, roots, valid, Number(cat.visibleRelation), id] : [channel.tenantId, roots, valid]
        count = (await client.query(sql, params)).rows[0].count
        selectionMode = cat.visibleRelation ? 'Yandex source category + relation + valid type + visible subtree' : 'valid type + visible subtree'
      }
      report.ranking.push({ id, name: cat.name, products: count, selectionMode,
        directMappings: cat.attributes.filter(row => row.attrIdent && !row.expr && String(row.id).startsWith('yandexattr_')).length })
    }
    report.ranking.sort((a, b) => (b.products ?? -1) - (a.products ?? -1) || b.directMappings - a.directMappings || a.id.localeCompare(b.id))
    report.characteristicFrequency = [...frequencies].map(([id, mappedCategories]) => ({ id, mappedCategories })).sort((a, b) => b.mappedCategories - a.mappedCategories)
    await client.query('ROLLBACK')
  } finally { await client.end() }
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ configuredCategories: cats.length, rankedCategories: report.ranking.filter(row => row.products !== null).length, top: report.ranking.slice(0, 6) }))
  if (metadataOnly) return
  const top = compareVisibility ? baseline.categories.map(old => report.ranking.find(row => row.id === old.id))
    : report.ranking.filter(row => row.products > 0 && row.directMappings > 0).slice(0, 3)
  if (!top.length) throw Error('No categories with measured usage')
  for (const ranked of top) {
    const cat = channel.mappings[ranked.id]
    const live = await loadYandexAttributes(ranked.id, channel.config.apiToken, config)
    const counts = new Map()
    for (const row of cat.attributes) counts.set(row.id, (counts.get(row.id) || 0) + 1)
    let selected = live.filter(attr => counts.get(attr.id) === 1 && !cat.attributes.find(row => row.id === attr.id).expr)
      .sort((a, b) => (frequencies.get(b.id) || 0) - (frequencies.get(a.id) || 0) || Number(b.required) - Number(a.required) || a.id.localeCompare(b.id)).slice(0, 10)
    if (compareVisibility) {
      // Freeze marketplace context as well as IDs: API metadata may change between trials.
      const oldRows = baseline.categories.find(row => row.id === ranked.id).runs[0].rows
      if (oldRows.some(row => counts.get(row.attribute.id) !== 1 || !live.some(attr => attr.id === row.attribute.id) || cat.attributes.find(attr => attr.id === row.attribute.id).expr)) throw Error('Baseline selection changed')
      selected = oldRows.map(row => ({ ...row.attribute, isNumber: row.attribute.numeric }))
    }
    const db = connection()
    let requests
    try {
      await db.connect()
      await db.query('BEGIN READ ONLY')
      await db.query("SET LOCAL statement_timeout='15s'")
      const roots = (cat.visible || []).map(Number)
      const relationId = cat.visibleRelation == null ? null : Number(cat.visibleRelation)
      const paths = (await db.query(mappingVisibilityPathsSQL, [channel.tenantId, roots, relationId])).rows.map(row => row.path)
      const targetPaths = relationId === null ? [] : (await db.query(mappingVisibilityTargetsSQL, [channel.tenantId, roots, relationId])).rows.map(row => row.path)
      if (roots.some(id => !paths.some(path => path.split('.').pop() === String(id)))) throw Error('Missing visibility roots')
      const base = buildMappingRequests(candidates, selected, 'ru', cat.valid?.length ? cat.valid : channel.valid || [], { paths, targetPaths, relationId })
      requests = await enrichMappingRequests(base, candidates, selected, 'ru', channel.tenantId,
        async (ids, tenantId, identifiers) => (await db.query(mappingLOVSamplesSQL, [tenantId, ids, identifiers])).rows)
      if (compareVisibility) for (const request of requests) {
        const old = baseline.categories.find(row => row.id === ranked.id).runs[0].rows.find(row => row.attribute.id === request.attribute.id)
        request.attribute = old.attribute
      }
      await db.query('ROLLBACK')
    } finally { await db.end() }
    const result = { ...ranked, liveAttributes: live.length, selected: requests.length, runs: [] }
    report.categories.push(result)
    for (let run = 1; run <= 2; run++) {
      const started = Date.now()
      const suggestions = await suggestMappings(requests, config, { category: typeof cat.name === 'string' ? cat.name : cat.name?.ru || ranked.id, language: 'ru' })
      const rows = requests.map(request => {
        const reference = cat.attributes.find(row => row.id === request.attribute.id)?.attrIdent || null
        const suggestion = suggestions.find(row => row.id === request.attribute.id)
        return { ...request, mappedCategories: frequencies.get(request.attribute.id) || 0, reference,
          referenceInShortlist: reference ? request.candidates.some(candidate => candidate.attrIdent === reference) : null,
          suggestion, agreesWithReference: reference ? suggestion.attrIdent === reference : null, humanVerdict: 'pending' }
      })
      result.runs.push({ run, elapsedMs: Date.now() - started, proposed: suggestions.filter(row => row.attrIdent).length,
        needsReview: suggestions.filter(row => row.needsReview).length, rows })
      if (run === 2) {
        result.repeatSame = rows.filter(row => row.suggestion.attrIdent === result.runs[0].rows.find(old => old.attribute.id === row.attribute.id).suggestion.attrIdent).length
        result.repeatSameNonNull = rows.filter(row => row.suggestion.attrIdent && row.suggestion.attrIdent === result.runs[0].rows.find(old => old.attribute.id === row.attribute.id).suggestion.attrIdent).length
      }
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
      console.log(JSON.stringify({ category: ranked.name, run, selected: rows.length, proposed: result.runs.at(-1).proposed, elapsedMs: result.runs.at(-1).elapsedMs, repeatSame: result.repeatSame }))
    }
  }
  const after = await loadSnapshot()
  report.originalMappingsUnchanged = JSON.stringify(after.channel.mappings) === original
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  if (!report.originalMappingsUnchanged) throw Error('Original mappings changed concurrently')
}
main().catch(error => { console.error('Popular mapping trial failed (' + (error.code || 'request-or-validation') + '). No database writes.'); process.exitCode = 1 })
