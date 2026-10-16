const { test } = require('node:test')
const assert = require('node:assert/strict')
const access = require('../src/channels/ai/access.ts')
const authorizeMapping = (context, manager, id, supported) => access.authorizeMapping(context, manager, id, supported, 7)
const resolveMappingSuggestions = (context, manager, args, config, getHandler, suggest) => access.resolveMappingSuggestions(context, manager, args, config, getHandler, suggest, 7)
const { withTenantMappingLock } = access

function fixtures() {
  const channel = { id: 42, tenantId: 'tenant', identifier: 'ozon', type: 3, valid: [10], mappings: { category: { id: 'cat_1', name: 'Category' } } }
  const context = { checkAuth() {}, getCurrentUser: () => ({ tenantId: 'tenant' }), canEditConfig: access => access === 7, canEditChannel: () => true, canViewChannel: () => true }
  const manager = { getChannels: () => [channel], getLanguages: () => [{ identifier: 'ru' }], getAttributesInfo: () => [{ visible: true, name: { ru: 'Group' }, attributes: [{ identifier: 'color', name: { ru: 'Цвет' }, valid: [10], type: 1 }] }] }
  return { channel, context, manager }
}

test('Yandex general fields use trusted metadata without a category API request and preserve mappings', async () => {
  const { context, manager, channel } = fixtures()
  channel.type = 9
  const before = JSON.stringify(channel)
  const result = await resolveMappingSuggestions(context, manager, {
    channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru',
    attributeIds: ['vendor', 'pictures', 'basicPrice', 'boxCount', 'adult']
  }, { enabled: true }, () => { throw Error('category API must not be needed') }, async requests => {
    assert.deepEqual(requests.map(row => row.attribute.typeName), ['text', 'textArray', 'object', 'integer', 'boolean'])
    return requests.map(row => ({ id: row.attribute.id, attrIdent: 'color', needsReview: false, reason: 'match' }))
  })
  assert.equal(result[0].needsReview, true)
  assert.equal(result[1].review.kind, 'conversion')
  assert.equal(result[2].review.kind, 'conversion')
  assert.equal(JSON.stringify(channel), before)
})

test('general field metadata cannot be redefined by category metadata or invented from saved mappings', async () => {
  const { context, manager, channel } = fixtures()
  channel.type = 9
  channel.mappings.category.attributes = [{ id: 'invented' }]
  const args = { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['vendor', 'a'] }
  const handler = () => ({ getAttributes: async () => [{ id: 'vendor', type: 'NUMERIC' }, { id: 'a', type: 'TEXT' }] })
  await resolveMappingSuggestions(context, manager, args, { enabled: true }, handler, async requests => {
    assert.equal(requests[0].attribute.typeName, 'text')
    return []
  })
  await assert.rejects(resolveMappingSuggestions(context, manager, { ...args, attributeIds: ['invented'] }, { enabled: true }, handler), /Unknown/)
  channel.type = 3
  await assert.rejects(resolveMappingSuggestions(context, manager, { ...args, attributeIds: ['name'] }, { enabled: true }, handler), /Unknown/)
})

test('resolver reviews every AI alternative using authoritative PIM types', async () => {
  const { context, manager, channel } = fixtures()
  channel.type = 9
  manager.getAttributesInfo = () => [{ visible: true, name: 'YM', attributes: [
    { identifier: 'color', name: 'Название', valid: [10], type: 1 },
    { identifier: 'number', name: 'Название числом', valid: [10], type: 4 },
  ] }]
  const result = await resolveMappingSuggestions(context, manager, {
    channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['name']
  }, { enabled: true }, () => { throw Error('no API') }, async () => [{
    id: 'name', attrIdent: 'color', reason: 'Preferred', needsReview: true,
    alternatives: [{ attrIdent: 'number', reason: 'Other', needsReview: false }],
  }])
  const options = result[0].review.options
  assert.equal(options.length, 2)
  assert.equal(options[0].recommended, true)
  assert.equal(options[0].review.pim.group, 'YM')
  assert.equal(options[1].review.kind, 'conversion')
  assert.equal(options[1].needsReview, true)
})

test('authorization requires authentication, tenant isolation and both channel/config permissions', () => {
  const { context, manager, channel } = fixtures()
  assert.equal(authorizeMapping(context, manager, '42', true).id, 42)
  assert.throws(() => authorizeMapping({ ...context, checkAuth() { throw Error('unauthenticated') } }, manager, '42', true), /unauthenticated/)
  for (const method of ['canEditConfig', 'canEditChannel', 'canViewChannel']) {
    assert.throws(() => authorizeMapping({ ...context, [method]: () => false }, manager, '42', true), /permissions/)
  }
  channel.tenantId = 'other'
  assert.throws(() => authorizeMapping(context, manager, '42', true), /channel/i)
})

test('authorization rejects malformed IDs and unsupported channel types', () => {
  const { context, manager, channel } = fixtures()
  assert.throws(() => authorizeMapping(context, manager, '42oops', true), /channel/i)
  channel.type = 10
  assert.throws(() => authorizeMapping(context, manager, '42', true), /supported/i)
})

test('resolver uses live handler metadata, filters standard fields and does not change saved mappings', async () => {
  const { context, manager, channel } = fixtures()
  const before = JSON.stringify(channel)
  let providerInput
  const result = await resolveMappingSuggestions(context, manager, {
    channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['a', '#name']
  }, { enabled: true }, () => ({ getAttributes: async () => [{ id: 'a', name: 'Цвет', dictionary: false }, { id: '#name', name: 'Name' }] }), async (requests) => {
    providerInput = requests
    return [{ id: 'a', attrIdent: 'color', needsReview: false, reason: 'match' }]
  })
  assert.equal(result[0].attrIdent, 'color')
  assert.equal(providerInput.length, 1)
  assert.equal(JSON.stringify(channel), before)
})

test('resolver rejects invalid language, category mismatch and unknown marketplace IDs', async () => {
  const { context, manager } = fixtures()
  const base = { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['a'] }
  const getHandler = () => ({ getAttributes: async () => [{ id: 'a', name: 'Цвет' }] })
  for (const overrides of [{ language: 'invented' }, { categoryId: 'cat_2' }, { attributeIds: ['unknown'] }]) {
    await assert.rejects(resolveMappingSuggestions(context, manager, { ...base, ...overrides }, { enabled: true }, getHandler), /language|category|attribute/i)
  }
})

test('resolver supplies bounded dictionary context to model and uses tenant-scoped LOV loader', async () => {
  const { context, manager } = fixtures()
  manager.getAttributesInfo = () => [{ visible: true, attributes: [{ identifier: 'color', name: 'Цвет', valid: [10], type: 7, lov: 15 }] }]
  let input
  await access.resolveMappingSuggestions(context, manager, { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['a'] }, { enabled: true },
    () => ({ getAttributes: async () => [{ id: 'a', name: 'Цвет', dictionary: true, dictionaryValues: [{ value: 'черный' }] }] }),
    async requests => { input = requests; return [] }, 7, undefined,
    async (ids, tenant) => { assert.deepEqual(ids, [15]); assert.equal(tenant, 'tenant'); return [{ id: 15, values: [{ value: { ru: 'чёрный' } }] }] })
  assert.deepEqual(input[0].attribute.valueOptions.examples, ['черный'])
  assert.deepEqual(input[0].candidates[0].valueOptions.examples, ['чёрный'])
})

test('tenant lock rejects overlap, isolates tenants and releases on failure', async () => {
  let finish
  const first = withTenantMappingLock('tenant', () => new Promise(resolve => { finish = resolve }))
  await assert.rejects(withTenantMappingLock('tenant', async () => 2), /already/i)
  assert.equal(await withTenantMappingLock('other', async () => 3), 3)
  finish(1)
  assert.equal(await first, 1)
  await assert.rejects(withTenantMappingLock('tenant', async () => { throw Error('failure') }), /failure/)
  assert.equal(await withTenantMappingLock('tenant', async () => 4), 4)
})

test('resolver loads visibility paths by tenant and excludes invisible candidates', async () => {
  const { context, manager, channel } = fixtures()
  channel.mappings.category.visible = ['30']
  channel.mappings.category.visibleRelation = 38
  manager.getAttributesInfo = () => [{ visible: true, attributes: [
    { identifier: 'color', name: 'Цвет', type: 1, valid: [10], visible: [20], relations: [38] },
    { identifier: 'foreign', name: 'Цвет', type: 1, valid: [10], visible: [31], relations: [38] }
  ] }]
  let input
  await access.resolveMappingSuggestions(context, manager, { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['a'] }, { enabled: true },
    () => ({ getAttributes: async () => [{ id: 'a', name: 'Цвет' }] }), async requests => { input = requests; return [] }, 7,
    async (ids, tenant, relationId) => { assert.deepEqual(ids, ['30']); assert.equal(tenant, 'tenant'); assert.equal(relationId, 38); return ['1.20.30'] })
  assert.deepEqual(input[0].candidates.map(c => c.attrIdent), ['color'])
})

test('resolver visibility includes descendants of selected catalog roots and rejects missing roots', async () => {
  const { context, manager, channel } = fixtures()
  channel.mappings.category.visible = [20]
  channel.mappings.category.visibleRelation = 38
  manager.getAttributesInfo = () => [{ visible: true, attributes: [{ identifier: 'child', type: 1, valid: [10], visible: [30], relations: [38] }] }]
  const args = { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['a'] }
  const handler = () => ({ getAttributes: async () => [{ id: 'a', name: 'Цвет' }] })
  let input
  await access.resolveMappingSuggestions(context, manager, args, { enabled: true }, handler, async requests => { input = requests; return [] }, 7, async () => ['1.20', '1.20.30'])
  assert.equal(input[0].candidates[0].attrIdent, 'child')
  for (const paths of [[], ['1.30'], ['1.20', 'bad.path']]) {
    await assert.rejects(access.resolveMappingSuggestions(context, manager, args, { enabled: true }, handler, async () => [], 7, async () => paths), /visibility/)
  }
})

test('resolver accepts separate source and target paths, validates both and filters direct product attributes', async () => {
  const { context, manager, channel } = fixtures()
  channel.mappings.category.visible = [20]
  channel.mappings.category.visibleRelation = 38
  manager.getAttributesInfo = () => [{ visible: true, attributes: [
    { identifier: 'target', name: 'Цвет', type: 7, valid: [10], visible: [200], relations: [] },
    { identifier: 'source_only', name: 'Цвет', type: 7, valid: [10], visible: [20], relations: [] }
  ] }]
  const args = { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['a'] }
  const handler = () => ({ getAttributes: async () => [{ id: 'a', name: 'Цвет' }] })
  let input
  await access.resolveMappingSuggestions(context, manager, args, { enabled: true }, handler, async requests => { input = requests; return [] }, 7,
    async () => ({ paths: ['1.20'], targetPaths: ['2.200.201'] }))
  assert.deepEqual(input[0].candidates.map(row => row.attrIdent), ['target'])
  await assert.rejects(access.resolveMappingSuggestions(context, manager, args, { enabled: true }, handler, async () => [], 7,
    async () => ({ paths: ['1.20'], targetPaths: ['bad.path'] })), /visibility/)
})

test('resolver filters the requested group before ranking and returns server review context', async () => {
  const { context, manager } = fixtures()
  manager.getAttributesInfo = () => [
    { identifier: 'erp', visible: true, attributes: [{ identifier: 'color', name: 'Цвет', type: 7, valid: [10] }] },
    { identifier: 'market', visible: true, attributes: [{ identifier: 'other', name: 'Цвет', type: 7, valid: [10] }] }
  ]
  const args = { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['a'], groupIdentifier: 'erp' }
  const handler = () => ({ getAttributes: async () => [{ id: 'a', name: 'Цвет', dictionary: true }] })
  const suggest = async requests => {
    assert.deepEqual(requests[0].candidates.map(row => row.attrIdent), ['color'])
    return [{ id: 'a', attrIdent: 'color', needsReview: true, reason: 'match' }]
  }
  const result = await access.resolveMappingSuggestions(context, manager, args, { enabled: true }, handler, suggest, 7)
  assert.equal(result[0].review.pim.attrIdent, 'color')
  assert.equal(result[0].review.marketplace.typeName, 'dictionary')
  await assert.rejects(access.resolveMappingSuggestions(context, manager, { ...args, groupIdentifier: 'missing' }, { enabled: true }, handler, suggest, 7), /group/i)
})

test('resolver unions selected groups before one hybrid retrieval and one LLM call', async () => {
  const { context, manager } = fixtures()
  const groups = [
    { identifier: 'erp', visible: true, name: 'ERP', attributes: [{ identifier: 'color', name: 'Цвет', type: 1, valid: [10] }] },
    { identifier: 'market', visible: true, name: 'Market', attributes: [{ identifier: 'other', name: 'Оттенок', type: 1, valid: [10] }, { identifier: 'color', name: 'Цвет', type: 1, valid: [10] }] },
    { identifier: 'outside', visible: true, attributes: [{ identifier: 'excluded', name: 'Цвет', type: 1, valid: [10] }] },
    { identifier: 'hidden', visible: false, attributes: [{ identifier: 'hidden', name: 'Цвет', type: 1, valid: [10] }] }
  ]
  manager.getAttributesInfo = () => groups
  let calls = 0; let retrievals = 0
  const args = { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['a'], groupIdentifiers: ['erp', 'market', 'erp'] }
  await access.resolveMappingSuggestions(context, manager, args, { enabled: true, retrievalMode: 'hybrid' }, () => ({ getAttributes: async () => [{ id: 'a', name: 'Цвет' }] }),
    async requests => { calls++; assert.deepEqual(requests[0].candidates.map(row => row.attrIdent).sort(), ['color', 'other']); return [] }, 7, undefined, undefined,
    async requests => { retrievals++; assert.equal(requests[0].candidates.length, 2); return { requests, diagnostics: { mode: 'hybrid' } } })
  assert.equal(calls, 1); assert.equal(retrievals, 1)
})

test('empty plural group selection retains all visible groups; unavailable and malformed selections are rejected', async () => {
  const { context, manager } = fixtures()
  manager.getAttributesInfo = () => [
    { identifier: 'a', visible: true, attributes: [{ identifier: 'color', name: 'Цвет', type: 1, valid: [10] }] },
    { identifier: 'b', visible: true, attributes: [{ identifier: 'weight', name: 'Вес', type: 4, valid: [10] }] },
    { identifier: 'hidden', visible: false, attributes: [{ identifier: 'hidden', valid: [10] }] },
    { identifier: 'duplicate', visible: true, attributes: [] }, { identifier: 'duplicate', visible: true, attributes: [] }
  ]
  const args = { channelId: '42', categoryId: 'cat_1', mappingKey: 'category', language: 'ru', attributeIds: ['x'], groupIdentifiers: [] }
  const handler = () => ({ getAttributes: async () => [{ id: 'x', name: 'Цвет' }] })
  await access.resolveMappingSuggestions(context, manager, args, { enabled: true }, handler, async requests => {
    assert.deepEqual(requests[0].candidates.map(row => row.attrIdent).sort(), ['color', 'weight']); return []
  }, 7)
  for (const groupIdentifiers of [['missing'], ['a', 'hidden'], ['duplicate'], [''], [4], 'a', Array(201).fill('a')]) {
    await assert.rejects(access.resolveMappingSuggestions(context, manager, { ...args, groupIdentifiers }, { enabled: true }, handler, async () => { throw Error('must not call LLM') }, 7), /group/i)
  }
  await assert.rejects(access.resolveMappingSuggestions(context, manager, { ...args, groupIdentifiers: ['b'], groupIdentifier: 'a' }, { enabled: true }, handler, async () => [], 7), /group/i)
})
