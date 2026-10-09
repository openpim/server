const test = require('node:test')
const assert = require('node:assert/strict')
const { sampleDictionary, enrichMappingRequests, loadMarketplaceDictionary } = require('../src/channels/ai/values.ts')
const { buildMappingRequests } = require('../src/channels/ai/mapping.ts')

test('dictionary samples localize, deduplicate, bound labels and omit IDs/headers', () => {
  const values = Array.from({ length: 12 }, (_, i) => ({ id: i, value: { ru: 'вариант ' + i + 'x'.repeat(100), en: 'SECRET_OTHER_LOCALE' }, headers: { token: 'SECRET_KEY' } }))
  const sample = sampleDictionary({ values, has_next: true }, 'ru')
  assert.equal(sample.examples.length, 8)
  assert.equal(sample.examples[0].length, 80)
  assert.equal(sample.truncated, true)
  assert.equal(sample.status, 'loaded')
  assert.ok(!JSON.stringify(sample).includes('SECRET'))
  assert.deepEqual(sampleDictionary({ result: [{ value: 'black' }, { value: 'black' }, { value: 'white' }] }, 'ru').examples, ['black', 'white'])
  assert.equal(sampleDictionary({}, 'ru').status, 'unavailable')
  assert.equal(sampleDictionary({ values: [] }, 'ru').status, 'loaded')
})

test('types and dictionary context enrich only shortlisted PIM candidates and preserve requests', async () => {
  const groups = [{ visible: true, attributes: [
    { identifier: 'type', name: 'Тип', type: 7, lov: 12, valid: [10] },
    { identifier: 'height', name: 'Высота', type: 4, valid: [10] },
    { identifier: 'excluded', name: 'Тип', type: 7, lov: 99, valid: [11] }
  ] }]
  const attrs = [{ id: 'a', name: 'Тип', dictionary: true, dictionaryValues: [{ value: 'винный шкаф' }], unit: 'см' }]
  const requests = buildMappingRequests(groups, attrs, 'ru', [10])
  const before = JSON.stringify(requests)
  let calls = 0
  const enriched = await enrichMappingRequests(requests, groups, attrs, 'ru', 'tenant', async (ids, tenant) => {
    calls++
    assert.deepEqual(ids, [12]); assert.equal(tenant, 'tenant')
    return [{ id: 12, values: [{ value: { ru: 'встраиваемый' } }], total: 5 }]
  })
  assert.equal(calls, 1)
  assert.equal(enriched[0].attribute.valueOptions.examples[0], 'винный шкаф')
  assert.equal(enriched[0].attribute.unit, 'см')
  const type = enriched[0].candidates.find(x => x.attrIdent === 'type')
  assert.deepEqual(type.valueOptions.examples, ['встраиваемый'])
  assert.equal(type.valueOptions.truncated, true)
  assert.equal(enriched[0].candidates.find(x => x.attrIdent === 'height').typeName, 'float')
  assert.equal(enriched[0].candidates.find(x => x.attrIdent === 'height').numeric, true)
  assert.equal(JSON.stringify(requests), before)
})

test('dictionary fetch failure is unknown context and never leaks error details', async () => {
  const requests = [{ attribute: { id: 'a', dictionary: true }, candidates: [{ attrIdent: 'x', type: 7, dictionary: true }] }]
  const groups = [{ attributes: [{ identifier: 'x', lov: 1 }] }]
  const result = await enrichMappingRequests(requests, groups, [{ id: 'a', dictionary: true }], 'ru', 'tenant', async () => { throw Error('SECRET') }, async () => { throw Error('SECRET') })
  assert.equal(result[0].attribute.valueOptions.status, 'unavailable')
  assert.equal(result[0].candidates[0].valueOptions.status, 'unavailable')
  assert.ok(!JSON.stringify(result).includes('SECRET'))
})

test('stale LOV links do not make numeric fields dictionaries; shared LOV context is marked', async () => {
  const groups = [{ visible: true, attributes: [
    { identifier: 'number', name: 'Вес', type: 4, lov: 10, valid: [10] },
    { identifier: 'kind', name: 'Тип', type: 7, lov: 10, valid: [10] },
    { identifier: 'material', name: 'Материал', type: 7, lov: 10, valid: [10] }
  ] }]
  const attrs = [{ id: 'a', name: 'Тип', dictionary: true, dictionaryValues: [] }]
  const base = buildMappingRequests(groups, attrs, 'ru', [10])
  assert.equal(base[0].candidates.find(x => x.attrIdent === 'number').dictionary, false)
  const enriched = await enrichMappingRequests(base, groups, attrs, 'ru', 'tenant', async () => [{ id: 10, values: [{ value: 'mixed' }] }])
  assert.equal(enriched[0].candidates.find(x => x.attrIdent === 'number').valueOptions, undefined)
  assert.equal(enriched[0].candidates.find(x => x.attrIdent === 'kind').valueOptions.sharedByAttributes, 3)
})

test('marketplace lookups reject foreign endpoints and omit arbitrary request metadata', async () => {
  let calls = 0
  const attribute = { id: 'a', dictionaryLink: 'https://evil.example/dict', dictionaryLinkPost: { headers: { 'Api-Key': 'SECRET', extra: 'do-not-forward' }, body: { attribute_id: 1, extra: 'do-not-forward' } } }
  const request = async (url, options) => {
    calls++
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.extra, undefined)
    assert.equal(JSON.parse(options.body).extra, undefined)
    return { ok: true, json: async () => ({ result: [{ id: 1, value: 'черный', headers: { token: 'SECRET' } }], has_next: true }) }
  }
  assert.deepEqual(await loadMarketplaceDictionary(attribute, {}, 100, request), {})
  assert.equal(calls, 0)
  attribute.dictionaryLink = 'https://api-seller.ozon.ru/v1/description-category/attribute/values'
  const sample = sampleDictionary(await loadMarketplaceDictionary(attribute, {}, 100, request), 'ru')
  assert.deepEqual(sample.examples, ['черный'])
  assert.equal(sample.total, null)
  assert.ok(!JSON.stringify(sample).includes('SECRET'))
})

test('marketplace deadline also aborts a response body stalled after headers', async () => {
  const attr = { id: 'a', dictionaryLink: 'https://api-seller.ozon.ru/v2/category/attribute/values', dictionaryLinkPost: { headers: {}, body: {} } }
  const start = Date.now()
  const result = await loadMarketplaceDictionary(attr, {}, 15, async (url, options) => ({ ok: true,
    json: () => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('PRIVATE_DETAIL')))) }))
  assert.deepEqual(result, {})
  assert.ok(Date.now() - start < 500)
})
