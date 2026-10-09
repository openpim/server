const test = require('node:test')
const assert = require('node:assert/strict')
const { buildMappingReview } = require('../src/channels/ai/review.ts')
const match = { id: 'a', attrIdent: 'pim', needsReview: true, reason: 'match' }

test('general arrays and objects require conversion, including when property scopes differ', () => {
  for (const typeName of ['object', 'textArray', 'objectArray']) {
    const review = buildMappingReview({ attribute: { id: 'a', name: 'Ширина упаковки', typeName },
      candidates: [{ attrIdent: 'pim', name: 'Ширина изделия', type: 1 }] }, { ...match, needsReview: false })
    assert.equal(review.kind, 'conversion')
    assert.ok(review.checks.includes('representation_differs'))
    assert.ok(review.checks.includes('scope_differs'))
    assert.ok(review.checks.includes(typeName === 'object' ? 'object_structure_required' : 'list_format_required'))
  }
})

test('simple general fields accept compatible types; a float cannot fill integer box count directly', () => {
  for (const [typeName, numeric, type] of [['text', false, 1], ['boolean', false, 2], ['integer', true, 3]]) {
    const review = buildMappingReview({ attribute: { id: 'a', name: 'Field', typeName, numeric },
      candidates: [{ attrIdent: 'pim', name: 'Field', type }] }, { ...match, needsReview: false })
    assert.equal(review.kind, 'direct')
  }
  assert.equal(buildMappingReview({ attribute: { id: 'a', name: 'Box count', typeName: 'integer', numeric: true },
    candidates: [{ attrIdent: 'pim', name: 'Box count', type: 4 }] }, { ...match, needsReview: false }).kind, 'conversion')
})

test('trusted general field catalog contains only enabled Yandex export fields', () => {
  const { yandexGeneralFields } = require('../src/channels/ai/yandexFields.ts')
  const ids = yandexGeneralFields.map(field => field.id)
  assert.equal(ids.length, 27)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(!ids.includes('offerid'))
  assert.ok(!ids.includes('marketCategoryId'))
  assert.ok(yandexGeneralFields.every(field => field.aiMappingScope === 'general' && field.type && field.description))
})

test('review derives unit conversion from metadata, not the model explanation', () => {
  const review = buildMappingReview({ attribute: { id: 'a', name: 'Мощность гриля', numeric: true, unit: 'Вт' },
    candidates: [{ attrIdent: 'pim', name: 'Мощность гриля, кВт', type: 4 }] }, { ...match, reason: 'units match' })
  assert.equal(review.kind, 'conversion')
  assert.ok(review.checks.includes('units_differ'))
  assert.equal(review.pim.unit, 'кВт')
})

test('review shows actual numeric PIM and marketplace dictionary types and bounded sample provenance', () => {
  const review = buildMappingReview({ attribute: { id: 'a', name: 'Количество стёкол', dictionary: true,
    valueOptions: { status: 'loaded', examples: ['одно', 'два'], total: 2, truncated: false } },
    candidates: [{ attrIdent: 'pim', name: 'Количество стёкол', type: 4 }] }, match)
  assert.equal(review.kind, 'conversion')
  assert.equal(review.marketplace.typeName, 'dictionary')
  assert.equal(review.pim.typeName, 'float')
  assert.deepEqual(review.marketplace.valueOptions.examples, ['одно', 'два'])
})

test('review flags scope differences and excludes arbitrary input metadata and secrets', () => {
  const review = buildMappingReview({ attribute: { id: 'a', name: 'Ширина встраивания, см', numeric: true, unit: 'см', headers: { token: 'SECRET' } },
    candidates: [{ attrIdent: 'pim', name: 'Ширина, см', type: 4, secret: 'SECRET' }] }, match)
  assert.equal(review.kind, 'review')
  assert.ok(review.checks.includes('scope_differs'))
  assert.ok(!JSON.stringify(review).includes('SECRET'))
  const shared = buildMappingReview({ attribute: { id: 'a', name: 'Цвет', dictionary: true },
    candidates: [{ attrIdent: 'pim', name: 'Цвет', type: 7, valueOptions: { status: 'loaded', examples: ['x'], sharedByAttributes: 901 } }] }, match)
  assert.ok(shared.checks.includes('shared_dictionary'))
})

test('unmatched review retains marketplace context and candidates without inventing a PIM match', () => {
  const review = buildMappingReview({ attribute: { id: 'a', name: 'Конфорок газовых', numeric: true },
    candidates: [{ attrIdent: 'pim', name: 'Количество конфорок', type: 4 }] }, { ...match, attrIdent: null })
  assert.equal(review.kind, 'unmatched')
  assert.equal(review.pim, null)
  assert.equal(review.candidates.length, 1)
  const proposed = buildMappingReview({ attribute: { id: 'a', name: 'Конфорок газовых', numeric: true },
    candidates: [{ attrIdent: 'pim', name: 'Количество конфорок', type: 4 }] }, match)
  assert.ok(proposed.checks.includes('scope_differs'))
})
