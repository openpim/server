// Explicit operator experiment: creates ONE inactive channel in kuppersberg.
// Stores first-run proposals, including those requiring review, only in that copy.
require('dotenv').config()
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const { loadSnapshot, loadYandexAttributes } = require('./kuppersberg-evaluate.cjs')
const { prepareCategory, applySuggestions, selectCandidateGroups, experimentCategory } = require('./sandbox-data.cjs')
const { readMappingConfig, buildMappingRequests, suggestMappings, createMappingVisibilityFilter } = require('../../src/channels/ai/mapping.ts')
const { mappingVisibilityPathsSQL, mappingVisibilityTargetsSQL } = require('../../src/channels/ai/visibility.ts')

const categoryDefinition = experimentCategory(process.argv.find(arg => arg.startsWith('--category='))?.slice('--category='.length))
const categoryId = categoryDefinition.id
const groupIdentifier = process.argv.find(arg => arg.startsWith('--group='))?.slice('--group='.length) || null
if (groupIdentifier && groupIdentifier !== 'mainAttrGroup') throw new Error('This experiment only supports mainAttrGroup restriction')
const metadataOnly = process.argv.includes('--metadata-only')
const scopeSuffix = groupIdentifier ? '-1c' : ''
const identifier = 'ym_ai_sandbox_20261008_' + categoryDefinition.slug + (groupIdentifier ? '_1c' : '')
const output = path.resolve(__dirname, '../../docs/ai-mapping/kuppersberg-' + (categoryDefinition.slug === 'wine' ? 'wine-' : '') + 'sandbox' + scopeSuffix + (metadataOnly ? '-metadata' : '-evaluation') + '.json')
const writeReport = report => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')

function databaseClient () {
  const database = process.env.OPENPIM_DATABASE_NAME || process.env.DATABASE_NAME
  if (database !== 'kuppersberg') throw new Error('Sandbox only supports kuppersberg')
  return new Client({ host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432), database,
    user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD,
    connectionTimeoutMillis: 10000 })
}

async function main () {
  const config = readMappingConfig()
  if (!config.enabled || config.baseUrl !== 'https://ollama.com/v1' || config.model !== 'deepseek-v4.1-flash') throw new Error('Expected authorized provider and model')
  const { channel, groups } = await loadSnapshot()
  const candidateGroups = selectCandidateGroups(groups, groupIdentifier)
  const source = channel.mappings[categoryId]
  if (!source || source.deleted || String(source.id) !== categoryId) throw new Error('Source category unavailable')
  const live = await loadYandexAttributes(categoryId, channel.config.apiToken, config)
  const rows = source.attributes
  const eligible = live.filter(attribute => {
    const matching = rows.filter(row => row.id === attribute.id)
    return matching.length === 1 && !matching[0].expr && !attribute.id.startsWith('#')
  }).slice(0, 30)
  if (!eligible.length) throw new Error('No eligible attributes')
  const ids = eligible.map(row => row.id)
  const category = prepareCategory(source, ids)
  // Keep default mapping for a usable editor; only one real category is copied.
  const mappings = { ...(channel.mappings._default ? { _default: channel.mappings._default } : {}), [categoryId]: category }
  const client = databaseClient()
  let report
  try {
    await client.connect()
    await client.query(metadataOnly ? 'BEGIN READ ONLY' : 'BEGIN')
    await client.query("SET LOCAL statement_timeout = '15s'")
    const visible = (category.visible || []).map(String)
    if (!visible.length) throw new Error('Visibility must be available for this experiment')
    const paths = (await client.query(mappingVisibilityPathsSQL, [channel.tenantId, visible, Number(category.visibleRelation)])).rows.map(row => row.path)
    if (!visible.every(id => paths.some(p => p.split('.').pop() === id))) throw new Error('Missing visibility roots')
    const valid = category.valid?.length ? category.valid : channel.valid
    const targetPaths = (await client.query(mappingVisibilityTargetsSQL, [channel.tenantId, visible, Number(category.visibleRelation)])).rows.map(row => row.path)
    const visibility = { paths, targetPaths, relationId: Number(category.visibleRelation) }
    const requests = buildMappingRequests(candidateGroups, eligible, 'ru', valid, visibility)
    const candidates = candidateGroups.filter(group => group.visible).flatMap(group => group.attributes)
      .filter(attribute => attribute.valid?.length && (!valid.length || attribute.valid.some(type => valid.map(String).includes(String(type)))))
    const scope = { group: groupIdentifier, groupName: groupIdentifier ? candidateGroups[0].name : null,
      groupAttributes: new Set(candidateGroups.flatMap(group => group.attributes).map(row => row.identifier)).size,
      poolBeforeVisibility: new Set(candidates.map(row => row.identifier)).size,
      poolAfterVisibility: new Set(candidates.filter(createMappingVisibilityFilter(visibility)).map(row => row.identifier)).size }
    if (metadataOnly) {
      await client.query('ROLLBACK')
      writeReport({ date: new Date().toISOString(), mode: 'metadata-only; no database writes or LLM calls', categoryId, ...scope,
        requests, previousMappings: rows.filter(row => ids.includes(row.id)).map(row => ({ id: row.id, attrIdent: row.attrIdent })) })
      console.log(JSON.stringify({ ...scope, selected: requests.length, metadataOnly: true }))
      return
    }
    const name = { ru: 'AI тест' + (groupIdentifier ? ' 1С' : '') + ' — ' + categoryDefinition.name + ' (08.10.2026)', en: 'AI experiment' + (groupIdentifier ? ' 1C' : '') + ' — ' + categoryDefinition.slug + ' (2026-10-08)' }
    const created = await client.query(`INSERT INTO channels
      (identifier, name, "order", "group", active, type, valid, visible, config, mappings, runtime,
       "parentId", "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt")
      SELECT $1, $2::jsonb, "order"+1, false, false, type, valid, visible, config, $3::jsonb, '{}'::jsonb,
       "parentId", "tenantId", 'codex-ai-experiment', 'codex-ai-experiment', NOW(), NOW()
      FROM channels WHERE id=$4 AND "tenantId"=$5 AND "deletedAt" IS NULL AND mappings=$6::jsonb
      RETURNING id, active`, [identifier, JSON.stringify(name), JSON.stringify(mappings), channel.id, channel.tenantId, JSON.stringify(channel.mappings)])
    if (created.rowCount !== 1) throw new Error('Source changed before copy')
    await client.query('COMMIT')
    report = { date: new Date().toISOString(), database: 'kuppersberg', sourceChannel: channel.id,
      sandboxChannel: created.rows[0].id, identifier, active: false, categoryId, categoryName: category.name,
      model: config.model, provider: config.baseUrl, batchSize: config.batchSize, timeoutMs: config.timeoutMs,
      candidateScope: scope,
      methodology: 'Two runs with identical shortlist and visibility. Existing mappings are withheld from LLM and are unverified references. First-run proposals are stored only in inactive copy; expression/system rows preserved.',
      liveAttributes: live.length, selected: requests.length, sourceUnchanged: null, saved: false, runs: [] }
    writeReport(report)
    console.log(JSON.stringify({ createdChannel: report.sandboxChannel, identifier, active: false, selected: requests.length }))
    for (let run = 1; run <= 2; run++) {
      const started = Date.now()
      const suggestions = await suggestMappings(requests, config, { category: category.name, language: 'ru' })
      // Validate scope before writing either report or DB proposals.
      applySuggestions(category, requests, suggestions)
      const evaluated = requests.map(request => {
        const suggestion = suggestions.find(row => row.id === request.attribute.id)
        if (!suggestion) throw new Error('Missing suggestion')
        const reference = rows.find(row => row.id === request.attribute.id).attrIdent || null
        const referenceAttribute = groups.flatMap(group => group.attributes).find(row => row.identifier === reference)
        return { id: request.attribute.id, name: request.attribute.name, reference,
          referenceName: referenceAttribute?.name || null,
          referenceInSelectedGroup: reference ? candidateGroups.some(group => group.attributes.some(row => row.identifier === reference)) : null,
          referenceInShortlist: reference ? request.candidates.some(row => row.attrIdent === reference) : null,
          candidates: request.candidates.map(row => ({ attrIdent: row.attrIdent, name: row.name, group: row.group, type: row.type })),
          suggestion: suggestion.attrIdent, needsReview: suggestion.needsReview, reason: suggestion.reason,
          agreesWithReference: reference ? reference === suggestion.attrIdent : null, humanVerdict: 'pending' }
      })
      const result = { run, elapsedMs: Date.now() - started, referenceCount: evaluated.filter(row => row.reference).length,
        referenceInSelectedGroup: evaluated.filter(row => row.reference && row.referenceInSelectedGroup).length,
        referenceInShortlist: evaluated.filter(row => row.referenceInShortlist).length,
        agreesWithReference: evaluated.filter(row => row.agreesWithReference).length,
        proposed: evaluated.filter(row => row.suggestion).length, rows: evaluated }
      report.runs.push(result)
      writeReport(report)
      console.log(JSON.stringify({ run, elapsedMs: result.elapsedMs, references: result.referenceCount,
        shortlistHits: result.referenceInShortlist, matches: result.agreesWithReference, proposed: result.proposed }))
    }
    const first = report.runs[0].rows
    report.repeatMatches = first.filter(row => report.runs[1].rows.find(other => other.id === row.id).suggestion === row.suggestion).length
    const filled = applySuggestions(category, requests, first.map(row => ({ id: row.id, attrIdent: row.suggestion })))
    const savedMappings = { ...mappings, [categoryId]: { ...filled, updatedAt: new Date().toISOString(), updatedBy: 'codex-ai-experiment' } }
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '15s'")
    const original = await client.query('SELECT mappings FROM channels WHERE id=$1 AND "tenantId"=$2 AND "deletedAt" IS NULL FOR UPDATE', [channel.id, channel.tenantId])
    report.sourceUnchanged = original.rowCount === 1 && JSON.stringify(original.rows[0].mappings) === JSON.stringify(channel.mappings)
    if (!report.sourceUnchanged) throw new Error('Source changed during evaluation; results not saved')
    const updated = await client.query(`UPDATE channels SET mappings=$1::jsonb, "updatedAt"=NOW(), "updatedBy"='codex-ai-experiment'
      WHERE id=$2 AND "tenantId"=$3 AND identifier=$4 AND active=false AND "deletedAt" IS NULL AND mappings=$5::jsonb RETURNING id`,
    [JSON.stringify(savedMappings), report.sandboxChannel, channel.tenantId, identifier, JSON.stringify(mappings)])
    if (updated.rowCount !== 1) throw new Error('Sandbox changed; results not saved')
    await client.query('COMMIT')
    report.saved = true
    writeReport(report)
    console.log(JSON.stringify({ saved: true, sourceUnchanged: true, repeatMatches: report.repeatMatches, total: report.selected }))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (report) { report.failure = error.code || 'request-or-validation'; writeReport(report) }
    throw error
  } finally { await client.end() }
}

main().catch(error => { console.error('Sandbox failed (' + (error.code || 'request-or-validation') + '). Check local report; no credentials are logged.'); process.exitCode = 1 })
