// Offline metadata snapshots + local Ollama only. No database, SAVE, export or chat API.
const fs = require('node:fs')
const path = require('node:path')
const { rankLexicalCandidates, buildMappingCandidatePools } = require('../../src/channels/ai/mapping.ts')
const { rankSemanticCandidates, rankHybridCandidates, embeddingText, evaluateRetrieval } = require('../../src/channels/ai/retrieval.ts')
const { LocalEmbeddingClient, readLocalEmbeddingConfig } = require('../../src/channels/ai/localEmbeddings.ts')

function valueOptionsMetadata (options) {
  if (!options || typeof options !== 'object') return undefined
  const loaded = options.status === 'loaded'
  const raw = Array.isArray(options.examples) ? options.examples : []
  const examples = loaded ? [...new Set(raw.filter(value => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)).map(value => String(value).slice(0, 100)))].slice(0, 8) : []
  return { status: loaded ? 'loaded' : 'unavailable', examples,
    total: Number.isSafeInteger(options.total) && options.total >= 0 ? options.total : null,
    truncated: !!options.truncated || raw.length > examples.length,
    sharedByAttributes: Number.isSafeInteger(options.sharedByAttributes) && options.sharedByAttributes >= 0 ? options.sharedByAttributes : 0,
    ...(options.attributeFiltered === true ? { attributeFiltered: true } : {}) }
}

function candidateMetadata (row) {
  return { attrIdent: String(row.attrIdent), name: String(row.name || ''), group: String(row.group || ''), type: Number(row.type) || 0,
    dictionary: !!row.dictionary, ...(row.typeName ? { typeName: String(row.typeName) } : {}), ...(row.numeric ? { numeric: true } : {}), valueOptions: valueOptionsMetadata(row.valueOptions) }
}

function targetMetadata (row) {
  return { id: String(row.id), name: String(row.name || ''), description: String(row.description || ''), dictionary: !!row.dictionary, numeric: !!row.numeric,
    ...(row.typeName ? { typeName: String(row.typeName) } : {}), valueOptions: valueOptionsMetadata(row.valueOptions) }
}

function prepareHistoricalDataset (sources) {
  const cases = new Map()
  for (const { source, document } of sources) {
    const categories = document.categories || [{ id: document.categoryId, name: document.categoryName, requests: document.requests, runs: document.runs }]
    for (const category of categories) {
      const rows = category.requests || category.runs?.[0]?.rows || category.rows || []
      const pool = [...new Map(rows.flatMap(row => row.candidates || []).filter(row => typeof row.attrIdent === 'string').map(row => [row.attrIdent, candidateMetadata(row)])).values()]
      const group = document.group || (typeof document.candidateScope === 'string' ? document.candidateScope : document.candidateScope?.group) || 'all-visible-groups'
      for (const row of rows) {
        const attribute = targetMetadata(row.attribute || row)
        if (!attribute.id || attribute.id === 'undefined' || !attribute.name) continue
        const id = [group, category.id, attribute.id].join('/')
        if (cases.has(id)) continue
        const runRow = category.runs?.[0]?.rows?.find(record => (record.id || record.attribute?.id) === attribute.id)
        cases.set(id, { id, category: String(category.id), categoryName: category.name || '', attribute, candidates: pool,
          poolComplete: false, source, historicalPoolSize: category.poolCount || category.poolAudit?.eligibleAfterTargetVisibility || null,
          reference: row.reference || runRow?.reference || null,
          label: { status: 'pending', expectedAttrIdents: [], reviewer: '', notes: '' } })
      }
    }
  }
  return { version: 1, scope: 'historical-kuppersberg-snapshots', language: 'ru', limitation: 'Candidate pools are unions of saved top30 lists, not complete live eligible pools. References are unconfirmed. This dataset supports diagnostics and human review, not production quality claims.', cases: [...cases.values()] }
}

function prepareSnapshotDataset (snapshot) {
  if (!snapshot.tenantId || !snapshot.language || !Array.isArray(snapshot.groups) || !Array.isArray(snapshot.categories)) throw new Error('Full snapshot requires tenantId, language, groups and categories.')
  const cases = snapshot.categories.flatMap(category => buildMappingCandidatePools(snapshot.groups, category.attributes, snapshot.language, category.valid || [], category.visibility)
    .map(request => ({ id: category.id + '/' + request.attribute.id, category: String(category.id), categoryName: category.name || '', attribute: request.attribute,
      candidates: request.candidates, poolComplete: true, label: snapshot.labels?.[category.id + '/' + request.attribute.id] || { status: 'pending', expectedAttrIdents: [], reviewer: '', notes: '' } })))
  return { version: 1, scope: String(snapshot.tenantId), language: snapshot.language, cases }
}

function validateDataset (dataset) {
  if (dataset.version !== 1 || typeof dataset.scope !== 'string' || !dataset.scope || typeof dataset.language !== 'string' || !dataset.language || !Array.isArray(dataset.cases) || !dataset.cases.length || dataset.cases.length > 1000) throw new Error('Invalid evaluation dataset.')
  const ids = new Set()
  for (const row of dataset.cases) {
    if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Invalid or duplicate evaluation case.')
    ids.add(row.id)
    if (!row.attribute?.id || typeof row.attribute.name !== 'string' || !row.attribute.name || typeof row.poolComplete !== 'boolean' || !Array.isArray(row.candidates) || row.candidates.length > 10000) throw new Error('Invalid target or candidate pool.')
    const candidateIds = new Set()
    for (const candidate of row.candidates) {
      if (typeof candidate.attrIdent !== 'string' || !candidate.attrIdent || candidateIds.has(candidate.attrIdent)) throw new Error('Invalid or duplicate candidate.')
      candidateIds.add(candidate.attrIdent)
      if (typeof candidate.name !== 'string' || typeof candidate.group !== 'string' || !Number.isFinite(candidate.type)) throw new Error('Invalid candidate metadata.')
    }
    if (!['pending', 'confirmed'].includes(row.label?.status) || !Array.isArray(row.label.expectedAttrIdents) || row.label.expectedAttrIdents.some(value => typeof value !== 'string' || !value) || new Set(row.label.expectedAttrIdents).size !== row.label.expectedAttrIdents.length) throw new Error('Invalid human label.')
    if (row.label.status === 'confirmed' && (typeof row.label.reviewer !== 'string' || !row.label.reviewer.trim())) throw new Error('Confirmed labels require a human reviewer.')
  }
}

async function compareDataset (dataset, client) {
  validateDataset(dataset)
  const started = Date.now()
  const provenance = await client.describeModel()
  const queryText = row => [row.categoryName, embeddingText(row.attribute)].filter(Boolean).join('\n')
  const texts = [...new Set(dataset.cases.flatMap(row => [queryText(row), ...row.candidates.map(embeddingText)]))]
  if (texts.length > 10000) throw new Error('Experiment unique-text limit exceeded.')
  const embedded = await client.embed(texts, dataset.scope, dataset.language)
  const vectors = new Map(texts.map((text, index) => [text, embedded[index]]))
  const rows = dataset.cases.map(row => {
    const lexical = rankLexicalCandidates(row.attribute, row.candidates)
    const candidateVectors = new Map(row.candidates.map(candidate => [candidate.attrIdent, vectors.get(embeddingText(candidate))]))
    const semantic = rankSemanticCandidates(row.candidates, vectors.get(queryText(row)), candidateVectors)
    const hybrid = rankHybridCandidates(row.attribute, row.candidates, semantic)
    const ids = list => list.slice(0, 30).map(candidate => candidate.attrIdent)
    return { ...row, rankings: { lexical: ids(lexical), semantic: ids(semantic), hybrid: ids(hybrid) } }
  })
  const drift = mode => ({ top1Changed: rows.filter(row => row.rankings.lexical[0] !== row.rankings[mode][0]).length,
    meanLexicalOverlapAt30: rows.reduce((sum, row) => sum + (row.rankings.lexical.length ? row.rankings[mode].filter(id => row.rankings.lexical.includes(id)).length / row.rankings.lexical.length : 1), 0) / rows.length })
  return { version: 1, date: new Date().toISOString(), scope: dataset.scope, language: dataset.language, provenance,
    method: 'cosine dense retrieval; equal-weight RRF k=60 with lexical exact matches retained; limit30',
    totalMs: Date.now() - started, uniqueTexts: texts.length, vectorDimensions: embedded[0]?.length || 0, cache: { ...client.stats }, evaluation: evaluateRetrieval(rows),
    diagnosticDrift: { semantic: drift('semantic'), hybrid: drift('hybrid') }, finalLLMEvaluated: false,
    limitation: dataset.limitation || null, rows }
}

function writeJSON (file, value, indent = 2) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const temporary = path.resolve(file) + '.tmp-' + process.pid
  fs.writeFileSync(temporary, JSON.stringify(value, null, indent) + '\n')
  fs.renameSync(temporary, path.resolve(file))
}

function readJSON (file) {
  if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('Experiment input/cache exceeds 32 MB.')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function main () {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index]
    if (!['--prepare', '--snapshot', '--dataset', '--out', '--cache', '--model', '--base-url'].includes(key) || args.has(key)) throw new Error('Unknown or duplicate experiment argument.')
    if (key === '--prepare') args.set(key, true)
    else { const value = process.argv[++index]; if (!value || value.startsWith('--')) throw new Error('Missing argument value.'); args.set(key, value) }
  }
  const output = args.get('--out')
  if (!output) throw new Error('--out is required. Use --prepare to create a historical review dataset, or --dataset to compare retrieval.')
  for (const key of ['--dataset', '--snapshot', '--cache']) if (args.get(key) && path.resolve(args.get(key)) === path.resolve(output)) throw new Error('Input/cache and report paths must differ.')
  if (args.has('--prepare')) {
    const files = ['kuppersberg-specific-metadata.json', 'kuppersberg-popular-filtered-evaluation.json', 'kuppersberg-wine-sandbox-1c-evaluation.json', 'kuppersberg-sandbox-1c-metadata.json', 'kuppersberg-visibility-metadata.json']
    const dataset = args.has('--snapshot') ? prepareSnapshotDataset(readJSON(args.get('--snapshot'))) : prepareHistoricalDataset(files.map(file => ({ source: file, document: readJSON(path.join(__dirname, '../../docs/ai-mapping', file)) })))
    validateDataset(dataset)
    writeJSON(output, dataset)
    console.log(JSON.stringify({ prepared: dataset.cases.length, pending: dataset.cases.filter(row => row.label.status === 'pending').length, completePools: dataset.cases.filter(row => row.poolComplete).length, output }))
    return
  }
  if (!args.has('--dataset') || !args.has('--cache')) throw new Error('--dataset and --cache are required for local evaluation.')
  const dataset = readJSON(args.get('--dataset'))
  const config = readLocalEmbeddingConfig({ ...process.env,
    ...(args.has('--model') ? { OPENPIM_AI_EMBEDDING_MODEL: args.get('--model') } : {}),
    ...(args.has('--base-url') ? { OPENPIM_AI_EMBEDDING_BASE_URL: args.get('--base-url') } : {}) })
  const client = new LocalEmbeddingClient(config, fs.existsSync(args.get('--cache')) ? readJSON(args.get('--cache')) : undefined)
  const report = await compareDataset(dataset, client)
  writeJSON(args.get('--cache'), client.exportCache(), 0)
  writeJSON(output, report)
  console.log(JSON.stringify({ cases: report.rows.length, totalMs: report.totalMs, cache: report.cache, evaluation: report.evaluation, diagnosticDrift: report.diagnosticDrift, output }))
}

module.exports = { prepareHistoricalDataset, prepareSnapshotDataset, validateDataset, compareDataset }
if (require.main === module) main().catch(error => { console.error('Retrieval experiment failed: ' + error.message); process.exitCode = 1 })
