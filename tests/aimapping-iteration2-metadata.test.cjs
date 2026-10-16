const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readMappingConfig } = require('../src/channels/ai/mapping.ts')
const { buildMappingReview } = require('../src/channels/ai/review.ts')

test('metres are recognized and require conversion to marketplace centimetres', () => {
  for (const unit of ['м', 'm']) {
    const review = buildMappingReview({ attribute: { id: 'a', name: 'Длина, см', numeric: true, unit: 'см', typeName: 'number' }, candidates: [{ attrIdent: 'length', name: 'Длина, ' + unit, type: 4 }] }, { id: 'a', attrIdent: 'length', needsReview: false })
    assert.equal(review.pim.unit, 'м')
    assert.ok(review.checks.includes('units_differ'))
  }
})

test('Bearer credentials require HTTPS for remote AI endpoints, loopback remains available', () => {
  const env = { OPENPIM_AI_MAPPING_ENABLED: 'true', OPENPIM_AI_PROVIDER: 'openai-compatible', OPENPIM_AI_MODEL: 'test', OPENPIM_AI_API_KEY: 'test-key' }
  assert.throws(() => readMappingConfig({ ...env, OPENPIM_AI_BASE_URL: 'http://example.com/v1' }), /HTTPS/i)
  assert.equal(readMappingConfig({ ...env, OPENPIM_AI_BASE_URL: 'http://127.0.0.1:1234/v1' }).enabled, true)
  assert.equal(readMappingConfig({ ...env, OPENPIM_AI_BASE_URL: 'https://example.com/v1' }).enabled, true)
})

test('Ozon metadata normalizes String and number types without inferring unknown types', () => {
  const { ozonAttributeType } = require('../src/channels/ozon/attributeMetadata.ts')
  assert.deepEqual(ozonAttributeType('String'), { type: 'TEXT', isNumber: false })
  assert.deepEqual(ozonAttributeType('Decimal'), { type: 'NUMERIC', isNumber: true })
  assert.deepEqual(ozonAttributeType('Integer'), { type: 'INTEGER', isNumber: true })
  assert.deepEqual(ozonAttributeType('Boolean'), { type: 'BOOLEAN', isNumber: false })
  assert.deepEqual(ozonAttributeType('FutureType'), { type: 'UNKNOWN', isNumber: false })
})
