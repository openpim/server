const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { readMappingConfig, buildMappingRequests, validateMappingResponse, suggestMappings } = require('../src/channels/ai/mapping.ts')
const { createMappingHTTPSAgent } = require('../src/channels/ai/provider.ts')

const groups = [{ name: { ru: 'Основные' }, visible: true, attributes: [
  { identifier: 'color', name: { ru: 'Цвет' }, type: 1, valid: [10] },
  { identifier: 'weight', name: { ru: 'Вес, кг' }, type: 3, valid: [10] },
  { identifier: 'title', name: { ru: 'Название' }, type: 1, valid: [10], languageDependent: true },
  { identifier: 'hidden', name: { ru: 'Цвет' }, type: 1, valid: [20] },
] }]
const attrs = [
  { id: 'a', name: 'Цвет', dictionary: false, description: 'Описание', dictionaryLinkPost: { headers: { 'Api-Key': 'MARKET_SECRET' } } },
  { id: 'b', name: 'Вес, г', isNumber: true, dictionary: false },
]
const requests = () => buildMappingRequests(groups, attrs, 'ru', [10])
const entry = (id = 'a', attrIdent = 'color', needsReview = false) => ({ id, attrIdent, needsReview, reason: 'Соответствует по смыслу' })
const configEnv = { OPENPIM_AI_MAPPING_ENABLED: 'true', OPENPIM_AI_PROVIDER: 'openai-compatible', OPENPIM_AI_BASE_URL: 'http://localhost:1234/v1', OPENPIM_AI_MODEL: 'test', OPENPIM_AI_RESPONSE_FORMAT: 'json_object' }

test('visibility filters same-relation categories before ranking and includes ancestors', () => {
  const attributes = [
    { identifier: 'leaf', name: { ru: 'Тип' }, valid: [10], visible: [30], relations: [38], type: 7 },
    { identifier: 'ancestor', name: { ru: 'Тип' }, valid: [10], visible: ['20'], relations: ['38'], type: 7 },
    { identifier: 'other_category', name: { ru: 'Тип' }, valid: [10], visible: [31], relations: [38], type: 7 },
  ]
  const data = buildMappingRequests([{ visible: true, attributes }], [{ id: 'a', name: 'Тип' }], 'ru', [10], { paths: ['1.20.30'], relationId: 38 })
  assert.deepEqual(data[0].candidates.map(c => c.attrIdent).sort(), ['ancestor', 'leaf'])
})

test('visibility preserves other relation domains, multi-relation alternatives and unknown context', () => {
  const attributes = [
    { identifier: 'other_relation', name: 'Цвет', valid: [10], visible: [999], relations: [4], type: 1 },
    { identifier: 'multi_relation', name: 'Цвет', valid: [10], visible: [999], relations: [38, 4], type: 1 },
    { identifier: 'direct', name: 'Цвет', valid: [10], visible: [999], relations: [], type: 1 },
    { identifier: 'relation_type', name: 'Цвет', valid: [10], visible: [999], relations: [38], type: 9 },
  ]
  const group = [{ visible: true, attributes }]
  const context = { paths: ['1.20.30'], relationId: 38 }
  assert.equal(buildMappingRequests(group, [attrs[0]], 'ru', [10], context)[0].candidates.length, 4)
  assert.equal(buildMappingRequests(group, [attrs[0]], 'ru', [10])[0].candidates.length, 4)
})

test('visibility with direct category paths excludes empty visibility and exact foreign IDs', () => {
  const attributes = [
    { identifier: 'global', name: 'Цвет', valid: [10], visible: [1], relations: [], type: 1 },
    { identifier: 'hidden', name: 'Цвет', valid: [10], visible: [], relations: [], type: 1 },
    { identifier: 'foreign', name: 'Цвет', valid: [10], visible: [2], relations: [], type: 1 },
  ]
  const result = buildMappingRequests([{ visible: true, attributes }], [attrs[0]], 'ru', [10], { paths: ['1.20.30'], relationId: null })
  assert.deepEqual(result[0].candidates.map(c => c.attrIdent), ['global'])
})

test('visibility considers all selected category paths without widening through ID prefixes', () => {
  const attributes = [
    { identifier: 'second', name: 'Цвет', valid: [10], visible: [40], relations: [38], type: 1 },
    { identifier: 'prefix', name: 'Цвет', valid: [10], visible: [4], relations: [38], type: 1 },
  ]
  const result = buildMappingRequests([{ visible: true, attributes }], [attrs[0]], 'ru', [10], { paths: ['1.20.30', '1.40'], relationId: 38 })
  assert.deepEqual(result[0].candidates.map(c => c.attrIdent), ['second'])
})

test('visibility preserves standard product attributes under relation context', () => {
  const attribute = { identifier: 'standard', name: 'Цвет', valid: [10], visible: [999], relations: [38], type: 1,
    options: [{ name: 'standard_attribute', value: 'true' }] }
  const groups = [{ visible: true, attributes: [attribute] }]
  assert.equal(buildMappingRequests(groups, [attrs[0]], 'ru', [10], { paths: ['1.20.30'], relationId: 38 })[0].candidates.length, 1)
  assert.equal(buildMappingRequests(groups, [attrs[0]], 'ru', [10], { paths: ['1.20.30'], relationId: null })[0].candidates.length, 0)
})

test('relation category separates product visibility from source categories for direct, standard and relation fields', () => {
  const attributes = [
    { identifier: 'width', name: 'Ширина', valid: [10], type: 4, visible: [200], relations: [] },
    { identifier: 'foreign_width', name: 'Ширина', valid: [10], type: 4, visible: [300], relations: [] },
    { identifier: 'standard', name: 'Ширина', valid: [10], type: 1, visible: [200], relations: [38], options: [{ name: 'standard_attribute', value: 'true' }] },
    { identifier: 'foreign_standard', name: 'Ширина', valid: [10], type: 1, visible: [20], relations: [38], options: [{ name: 'standard_attribute', value: 'true' }] },
    { identifier: 'relation_field', name: 'Ширина', valid: [10], type: 9, visible: [200], relations: [38] },
    { identifier: 'foreign_relation_field', name: 'Ширина', valid: [10], type: 9, visible: [20], relations: [38] },
    { identifier: 'source', name: 'Ширина', valid: [10], type: 7, visible: [20], relations: [38] },
    { identifier: 'foreign_source', name: 'Ширина', valid: [10], type: 7, visible: [200], relations: [38] },
  ]
  const result = buildMappingRequests([{ visible: true, attributes }], [{ id: 'a', name: 'Ширина' }], 'ru', [10],
    { paths: ['1.20.30'], targetPaths: ['2.200.201'], relationId: 38 })
  assert.deepEqual(result[0].candidates.map(row => row.attrIdent).sort(), ['relation_field', 'source', 'standard', 'width'])
})

test('missing product paths preserve uncertain domains; multiple target paths accept any matching category', () => {
  const attributes = [
    { identifier: 'first', name: 'Вес', valid: [10], type: 4, visible: [200], relations: [] },
    { identifier: 'second', name: 'Вес', valid: [10], type: 4, visible: [300], relations: [] },
    { identifier: 'foreign', name: 'Вес', valid: [10], type: 4, visible: [20], relations: [] },
    { identifier: 'other_domain', name: 'Вес', valid: [10], type: 7, visible: [900], relations: [4] },
  ]
  const group = [{ visible: true, attributes }]
  assert.equal(buildMappingRequests(group, [attrs[0]], 'ru', [10], { paths: ['1.20'], targetPaths: [], relationId: 38 })[0].candidates.length, 4)
  const result = buildMappingRequests(group, [attrs[0]], 'ru', [10], { paths: ['1.20'], targetPaths: ['2.200.201', '2.300.301'], relationId: 38 })
  assert.deepEqual(result[0].candidates.map(row => row.attrIdent).sort(), ['first', 'other_domain', 'second'])
})

test('colour inflections outrank filler words in a crowded dictionary shortlist', () => {
  const attributes = Array.from({ length: 40 }, (_, i) => ({ identifier: 'noise_' + i, name: 'Для аксессуара ' + i, valid: [10], type: 7 }))
  attributes.push({ identifier: 'erp_colour', name: 'Цвета', valid: [10], type: 7 })
  const result = buildMappingRequests([{ visible: true, attributes }], [{ id: 'a', name: 'Цвет для фильтра', dictionary: true }], 'ru', [10])
  assert.equal(result[0].candidates[0].attrIdent, 'erp_colour')
})

test('normalised dimensions and units keep differing dimensions separate and numeric types ahead of text ties', () => {
  const attributes = [
    { identifier: 'a_text', name: 'Ширина в сантиметрах', valid: [10], type: 1 },
    { identifier: 'width', name: 'Ширина в сантиметрах', valid: [10], type: 4 },
    { identifier: 'height', name: 'Высота, см', valid: [10], type: 4 },
  ]
  const result = buildMappingRequests([{ visible: true, attributes }], [{ id: 'a', name: 'Ширина, см (Number)', isNumber: true }], 'ru', [10])
  assert.equal(result[0].candidates[0].attrIdent, 'width')
})

test('configuration is disabled by default and rejects unsafe/invalid configuration', () => {
  assert.equal(readMappingConfig({}).enabled, false)
  assert.throws(() => readMappingConfig({ ...configEnv, OPENPIM_AI_PROVIDER: 'unknown' }), /provider/i)
  assert.throws(() => readMappingConfig({ ...configEnv, OPENPIM_AI_BASE_URL: 'file:///tmp/key' }), /URL/)
  assert.throws(() => readMappingConfig({ ...configEnv, OPENPIM_AI_PROVIDER: 'openai', OPENPIM_AI_API_KEY: '' }), /API_KEY/)
  assert.throws(() => readMappingConfig({ ...configEnv, OPENPIM_AI_MAPPING_BATCH_SIZE: '0' }), /BATCH_SIZE/)
})

test('system certificate trust is opt-in and keeps HTTPS certificate verification enabled', () => {
  assert.equal(readMappingConfig(configEnv).useSystemCA, false)
  assert.equal(readMappingConfig({ ...configEnv, OPENPIM_AI_USE_SYSTEM_CA: 'true' }).useSystemCA, true)
  assert.equal(createMappingHTTPSAgent(false), undefined)
  const agent = createMappingHTTPSAgent(true)
  try {
    assert.equal(agent.options.rejectUnauthorized, true)
    assert.ok(Array.isArray(agent.options.ca) && agent.options.ca.length > 0)
  } finally { agent.destroy() }
})

test('metadata excludes credentials and incompatible item types and preserves locale candidates', () => {
  const data = requests()
  const json = JSON.stringify(data)
  assert.ok(!json.includes('MARKET_SECRET'))
  assert.ok(!json.includes('headers'))
  assert.ok(!json.includes('hidden'))
  assert.ok(json.includes('title#ru'))
  assert.equal(data[0].candidates[0].attrIdent, 'color')
})

test('hidden groups and relation-only attributes are not candidates', () => {
  const result = buildMappingRequests([{ ...groups[0], visible: false }], attrs, 'ru', [10])
  assert.ok(result.every(r => r.candidates.length === 0))
})

test('known matches are returned and omitted results become unmatched', () => {
  const result = validateMappingResponse({ suggestions: [entry()] }, requests())
  assert.equal(result[0].attrIdent, 'color')
  assert.equal(result[0].needsReview, false)
  assert.equal(result[1].attrIdent, null)
})

test('alternatives are bounded, unique and restricted to the same marketplace shortlist', () => {
  const input = requests()
  input[0].candidates.push({ attrIdent: 'other_title', name: 'Название', type: 1, dictionary: false, group: 'YM' })
  const result = validateMappingResponse({ suggestions: [{ ...entry(), alternatives: [
    { attrIdent: 'other_title', reason: 'Источник для Яндекса' },
    { attrIdent: 'other_title', reason: 'duplicate' },
    { attrIdent: 'invented', reason: 'invalid' },
  ] }] }, input)
  assert.deepEqual(result[0].alternatives, [{ attrIdent: 'other_title', reason: 'Источник для Яндекса', needsReview: true }])
  assert.equal(result[0].needsReview, true)
  assert.throws(() => validateMappingResponse({ suggestions: [{ ...entry(), alternatives: 'bad' }] }, input), /Invalid/)
})

test('unknown marketplace IDs, duplicates and invalid shapes fail atomically', () => {
  for (const suggestions of [[entry('unknown')], [entry(), entry()], [{ ...entry(), needsReview: 'false' }]]) {
    assert.throws(() => validateMappingResponse({ suggestions }, requests()), /identifier|duplicate|invalid/i)
  }
})

test('unapproved PIM identifiers remain unmatched without discarding valid suggestions', () => {
  const result = validateMappingResponse({ suggestions: [entry('a', 'invented'), entry('b', 'weight')] }, requests())
  assert.equal(result[0].attrIdent, null)
  assert.equal(result[0].needsReview, true)
  assert.match(result[0].reason, /кандидат/)
  assert.ok(!result[0].reason.includes('invented'))
  assert.equal(result[1].attrIdent, 'weight')
})

test('identifiers from another attribute shortlist are not accepted or guessed', () => {
  const restricted = requests()
  restricted[0].candidates = restricted[0].candidates.filter(candidate => candidate.attrIdent === 'color')
  for (const identifier of ['weight', '', 'null', ' color ', 'COLOR', 'title']) {
    const result = validateMappingResponse({ suggestions: [entry('a', identifier)] }, restricted)
    assert.equal(result[0].attrIdent, null)
    assert.equal(result[0].needsReview, true)
  }
})

test('dictionary and numeric matches require review independently of the model', () => {
  const dictionaryRequests = buildMappingRequests(groups, [{ ...attrs[0], dictionary: true }], 'ru', [10])
  assert.equal(validateMappingResponse({ suggestions: [entry()] }, dictionaryRequests)[0].needsReview, true)
  assert.equal(validateMappingResponse({ suggestions: [entry('b', 'weight')] }, requests())[1].needsReview, true)
  const unknownUnitRequest = buildMappingRequests(groups, [{ id: 'c', name: 'Масса', dictionary: false }], 'ru', [10])
  assert.equal(validateMappingResponse({ suggestions: [entry('c', 'weight')] }, unknownUnitRequest)[0].needsReview, true)
})

test('strict JSON schema is passed to the provider', async t => {
  const config = await endpoint(t, (req, res, body) => {
    assert.equal(body.response_format.type, 'json_schema')
    assert.equal(body.response_format.json_schema.strict, true)
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [entry()] }) }, finish_reason: 'stop' }] }))
  })
  assert.equal((await suggestMappings(requests(), { ...config, responseFormat: 'json_schema' }))[0].attrIdent, 'color')
})

async function endpoint(t, handler) {
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    handler(req, res, JSON.parse(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  return readMappingConfig({ ...configEnv, OPENPIM_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` })
}

test('HTTP integration sends metadata only and validates structured JSON responses', async t => {
  const config = await endpoint(t, (req, res, body) => {
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(body.model, 'test')
    assert.equal(body.response_format.type, 'json_object')
    assert.ok(!JSON.stringify(body).includes('MARKET_SECRET'))
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [entry()] }) }, finish_reason: 'stop' }] }))
  })
  assert.equal((await suggestMappings(requests(), config))[0].attrIdent, 'color')
})

test('dictionary-rich input automatically uses smaller batches within provider payload limit', async t => {
  let calls = 0
  const config = await endpoint(t, (req, res, body) => {
    calls++
    assert.ok(JSON.stringify(body.messages).length < 200000)
    const data = JSON.parse(body.messages[1].content)
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: data.attributes.map(row => entry(row.attribute.id, 'p0')) }) }, finish_reason: 'stop' }] }))
  })
  config.batchSize = 20
  const big = ['a', 'b', 'c', 'd'].map(id => ({ attribute: { id, name: 'Тип', dictionary: true },
    candidates: Array.from({ length: 30 }, (_, i) => ({ attrIdent: 'p'+i, name: 'n'.repeat(400), group: 'g'.repeat(800), type: 7, dictionary: true,
      valueOptions: { status: 'loaded', examples: Array(8).fill('v'.repeat(80)), total: 100, truncated: true } })) }))
  assert.equal((await suggestMappings(big, config)).length, 4)
  assert.equal(calls, 2)
})

test('provider errors never expose response bodies or credentials', async t => {
  const config = await endpoint(t, (req, res) => { res.statusCode = 401; res.end('PRIVATE_PROVIDER_DETAIL') })
  await assert.rejects(suggestMappings(requests(), config), error => /401/.test(error.message) && !error.message.includes('PRIVATE_PROVIDER_DETAIL'))
})

test('malformed and truncated outputs are rejected', async t => {
  const config = await endpoint(t, (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '{oops' }, finish_reason: 'length' }] })))
  await assert.rejects(suggestMappings(requests(), config), /incomplete|invalid/i)
})

test('deadline aborts a hung provider', async t => {
  const config = await endpoint(t, () => {})
  await assert.rejects(suggestMappings(requests(), { ...config, timeoutMs: 30 }), /timeout/i)
})

test('deadline aborts a provider that sends headers but stalls the response body', async t => {
  const config = await endpoint(t, (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{') })
  await assert.rejects(suggestMappings(requests(), { ...config, timeoutMs: 30 }), /timeout/i)
})

test('redirects are rejected without following another provider URL', async t => {
  let count = 0
  const config = await endpoint(t, (req, res) => { count++; res.writeHead(302, { Location: '/redirected' }); res.end() })
  await assert.rejects(suggestMappings(requests(), config), /connection failed/i)
  assert.equal(count, 1)
})

test('invalid JSON in an otherwise completed provider output is rejected', async t => {
  const config = await endpoint(t, (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: 'not JSON' }, finish_reason: 'stop' }] })))
  await assert.rejects(suggestMappings(requests(), config), /invalid mapping JSON/i)
})

test('a later batch failure does not return partially successful suggestions', async t => {
  let count = 0
  const config = await endpoint(t, (req, res) => {
    count++
    if (count > 1) { res.statusCode = 503; res.end('error'); return }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [entry()] }) }, finish_reason: 'stop' }] }))
  })
  await assert.rejects(suggestMappings(requests(), { ...config, batchSize: 1 }), /503/)
})
