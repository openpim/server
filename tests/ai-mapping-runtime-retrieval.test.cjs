const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readMappingConfig } = require('../src/channels/ai/mapping.ts')
const runtime = () => require('../src/channels/ai/runtimeRetrieval.ts')
const sample = examples => ({ status: 'loaded', examples })
const context = { tenantId: 'tenant', channelId: '42', language: 'ru', category: 'Панели' }
const candidates = () => Array.from({ length: 40 }, (_, i) => ({ attrIdent: 'a' + String(i).padStart(2, '0'), name: 'Свойство ' + i, group: 'Основные', type: 1 }))

test('runtime configuration enables hybrid with explicit lexical opt-out', () => {
  const env = { OPENPIM_AI_MAPPING_ENABLED: 'true', OPENPIM_AI_PROVIDER: 'openai-compatible', OPENPIM_AI_BASE_URL: 'http://localhost:1234/v1', OPENPIM_AI_MODEL: 'model' }
  assert.equal(readMappingConfig(env).retrievalMode, 'hybrid')
  assert.equal(readMappingConfig({ ...env, OPENPIM_AI_MAPPING_RETRIEVAL: 'lexical' }).retrievalMode, 'lexical')
  assert.throws(() => readMappingConfig({ ...env, OPENPIM_AI_MAPPING_RETRIEVAL: 'bad' }), /RETRIEVAL/)
})

test('profiles bound allowlisted descriptions/units; values are separate, generic and shared domains excluded', () => {
  const { meaningProfile, valueProfile } = runtime()
  const row = { name: 'Материал', description: 'Описание'.repeat(1500), unit: 'кг', dictionaryLinkPost: { headers: { key: 'SECRET' } }, valueOptions: sample(['сталь', 'алюминий']) }
  const text = meaningProfile(row)
  assert.ok(text.includes('кг')); assert.ok(text.includes('Описание'))
  assert.ok(text.length <= 6000); assert.ok(!text.includes('SECRET')); assert.ok(!text.includes('сталь'))
  assert.ok(valueProfile(row).includes('сталь'))
  assert.equal(valueProfile({ valueOptions: sample(['Да', 'Нет', 'true', 'false', '0', '1']) }), '')
  assert.equal(valueProfile({ valueOptions: { ...sample(['сталь']), sharedByAttributes: 3 } }), '')
  assert.ok(valueProfile({ valueOptions: { ...sample(['сталь']), sharedByAttributes: 3, attributeFiltered: true } }).includes('сталь'))
  assert.equal(valueProfile({ valueOptions: { ...sample(['сталь']), status: 'unavailable' } }), '')
})

test('hybrid recovers a source outside lexical30 using enriched description and all eligible candidates', async () => {
  const pool = candidates(); pool[39].description = 'Искомый материал поверхности'
  pool[0].name = 'Материал'
  const requests = [{ attribute: { id: 'x', name: 'Материал', description: 'Искомый материал поверхности' }, candidates: pool }]
  const before = JSON.stringify(requests)
  const scopes = []
  const client = { embed: async (texts, scope, language, deadline) => {
    scopes.push(scope); assert.equal(language, 'ru'); assert.ok(deadline > Date.now())
    return texts.map(text => text.includes('Искомый') ? [1, 0] : [0, 1])
  } }
  const result = await runtime().retrieveMappingCandidates(requests, context, 'hybrid', client)
  assert.equal(result.diagnostics.mode, 'hybrid')
  assert.equal(result.requests[0].candidates.length, 30)
  assert.equal(result.requests[0].candidates[0].attrIdent, 'a00')
  assert.ok(result.requests[0].candidates.some(row => row.attrIdent === 'a39'))
  assert.equal(JSON.stringify(requests), before)
  await runtime().retrieveMappingCandidates(requests, { ...context, tenantId: 'other' }, 'hybrid', client)
  assert.notEqual(scopes[0], scopes[1])
})

test('value domains break equal meaning scores but cannot override a substantially different meaning', async () => {
  const { rankProfileCandidates } = runtime()
  const pool = [{ attrIdent: 'wrong', name: 'A', valueOptions: sample(['пластик']) }, { attrIdent: 'right', name: 'B', valueOptions: sample(['сталь']) }]
  const query = { name: 'Материал', valueOptions: sample(['сталь']) }
  const vectors = new Map([
    [runtime().meaningProfile(query), [1, 0]],
    [runtime().meaningProfile(pool[0]), [1, 0]], [runtime().meaningProfile(pool[1]), [1, 0]],
    [runtime().valueProfile(query), [1, 0]], [runtime().valueProfile(pool[0]), [0, 1]]
  ])
  assert.equal(rankProfileCandidates(query, pool, vectors)[0].attrIdent, 'right')
  vectors.set(runtime().meaningProfile(pool[1]), [0, 1])
  assert.equal(rankProfileCandidates(query, pool, vectors)[0].attrIdent, 'wrong')
})

test('embedding failures have sanitized lexical fallback and lexical mode does not call embeddings', async () => {
  const requests = [{ attribute: { id: 'x', name: 'Test' }, candidates: candidates() }]
  let calls = 0
  const client = { embed: async () => { calls++; throw Error('SECRET') } }
  const fallback = await runtime().retrieveMappingCandidates(requests, context, 'hybrid', client)
  assert.equal(fallback.diagnostics.mode, 'lexical')
  assert.equal(fallback.diagnostics.fallback, 'embedding_unavailable')
  assert.ok(!JSON.stringify(fallback).includes('SECRET'))
  assert.deepEqual(fallback.requests[0].candidates, requests[0].candidates.slice(0, 30))
  await runtime().retrieveMappingCandidates(requests, context, 'lexical', client)
  assert.equal(calls, 1)
})

test('empty and oversized pools do not call embedding provider', async () => {
  const client = { embed: async () => { throw Error('must not call') } }
  const empty = await runtime().retrieveMappingCandidates([{ attribute: { name: 'x' }, candidates: [] }], context, 'hybrid', client)
  assert.equal(empty.diagnostics.fallback, undefined)
  const large = await runtime().retrieveMappingCandidates([{ attribute: { name: 'x' }, candidates: Array.from({ length: 2001 }, (_, i) => ({ attrIdent: String(i), name: String(i) })) }], context, 'hybrid', client)
  assert.equal(large.diagnostics.fallback, 'pool_limit')
  assert.equal(large.requests[0].candidates.length, 30)
})

test('resolver enriches full eligible pool before retrieval and returns diagnostics without saving', async () => {
  const { resolveMappingSuggestions } = require('../src/channels/ai/access.ts')
  const channel = { id: 42, tenantId: 'tenant', identifier: 'ozon', type: 3, valid: [10], mappings: { cat: { id: 'c', name: 'Материалы' } } }
  const before = JSON.stringify(channel)
  const groups = [{ visible: true, name: 'PIM', attributes: [
    ...candidates().map(row => ({ ...row, identifier: row.attrIdent, valid: [10] })),
    { identifier: 'z_material', name: 'Источник', type: 7, lov: 10, valid: [10], options: [{ name: 'description', value: 'Материал поверхности' }] },
    { identifier: 'forbidden', name: 'Материал', type: 7, lov: 11, valid: [20] }
  ] }]
  const ctx = { checkAuth() {}, getCurrentUser: () => ({ tenantId: 'tenant' }), canEditConfig: () => true, canEditChannel: () => true, canViewChannel: () => true }
  const manager = { getChannels: () => [channel], getLanguages: () => [{ identifier: 'ru' }], getAttributesInfo: () => groups }
  let retrievalCalled = false
  const result = await resolveMappingSuggestions(ctx, manager,
    { channelId: '42', categoryId: 'c', mappingKey: 'cat', language: 'ru', attributeIds: ['x'] }, { enabled: true, retrievalMode: 'hybrid' },
    () => ({ getAttributes: async () => [{ id: 'x', name: 'Материал', description: 'Материал поверхности', dictionary: true, dictionaryValues: ['сталь', 'алюминий'] }] }),
    async requests => {
      assert.equal(retrievalCalled, true)
      assert.equal(requests[0].candidates.length, 30)
      assert.ok(requests[0].candidates.some(row => row.attrIdent === 'z_material'))
      return [{ id: 'x', attrIdent: 'z_material', needsReview: true, reason: 'match' }]
    }, 7, undefined,
    async (ids, tenant, identifiers) => {
      assert.deepEqual(ids, [10]); assert.ok(identifiers.includes('z_material'))
      return [{ id: 10, attributeIdent: 'z_material', values: ['сталь', 'алюминий'] }]
    },
    async (requests, context, mode) => {
      retrievalCalled = true
      assert.equal(requests[0].candidates.length, 41)
      assert.equal(context.category, 'Материалы')
      const late = requests[0].candidates.find(row => row.attrIdent === 'z_material')
      assert.equal(late.description, 'Материал поверхности')
      assert.deepEqual(late.valueOptions.examples, ['сталь', 'алюминий'])
      return runtime().retrieveMappingCandidates(requests, context, mode, {
        embed: async texts => texts.map(text => text.includes('Материал поверхности') || text.startsWith('Value domain:') ? [1, 0] : [0, 1])
      })
    })
  assert.equal(result[0].review.retrieval.mode, 'hybrid')
  assert.equal(JSON.stringify(channel), before)
})

test('whole-operation embedding deadline includes model discovery and aborts body reads', async () => {
  const http = require('node:http')
  const { LocalEmbeddingClient } = require('../src/channels/ai/localEmbeddings.ts')
  let embeds = 0
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: 'bge-m3:latest', digest: 'a'.repeat(64) }] }))
    else if (req.url === '/api/show') res.end(JSON.stringify({ capabilities: ['embedding'] }))
    else { embeds++; res.write('{"embeddings":'); /* deliberately never finish */ }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new LocalEmbeddingClient({ baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'bge-m3', timeoutMs: 10000, batchSize: 1 })
    const started = Date.now()
    await assert.rejects(client.embed(['A', 'B'], 'tenant', 'ru', started + 150), /timeout/)
    assert.ok(Date.now() - started < 2000)
    assert.equal(embeds, 1)
    await assert.rejects(client.embed(['C'], 'tenant', 'ru', Date.now() - 1), /timeout/)
    assert.equal(embeds, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('multi-query ranking yields to other server requests before completing', async () => {
  let responsive = false
  const pool = candidates()
  const requests = Array.from({ length: 10 }, (_, i) => ({ attribute: { name: 'Query ' + i }, candidates: pool }))
  const client = { embed: async texts => {
    setImmediate(() => { responsive = true })
    return texts.map(() => [1, 0])
  } }
  const result = await runtime().retrieveMappingCandidates(requests, context, 'hybrid', client)
  assert.equal(responsive, true)
  assert.equal(result.diagnostics.mode, 'hybrid')
})

test('expired operation budget prevents ranking and returns lexical fallback', async () => {
  const now = Date.now
  try {
    const client = { embed: async texts => {
      const future = now() + 61000
      Date.now = () => future
      return texts.map(() => [1, 0])
    } }
    const result = await runtime().retrieveMappingCandidates([{ attribute: { name: 'Query' }, candidates: candidates() }], context, 'hybrid', client)
    assert.equal(result.diagnostics.mode, 'lexical')
    assert.equal(result.diagnostics.fallback, 'embedding_unavailable')
  } finally { Date.now = now }
})
