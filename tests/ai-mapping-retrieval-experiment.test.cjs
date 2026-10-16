const { test } = require('node:test')
const assert = require('node:assert/strict')
const experiment = () => require('../scripts/ai-mapping/retrieval-experiment.cjs')

test('historical preparation expands the shared pool but never marks references or model suggestions gold', () => {
  const { prepareHistoricalDataset } = experiment()
  const candidate = (id, name) => ({ attrIdent: id, name, group: 'Main', type: 1 })
  const document = { categories: [{ id: 'c', name: 'Category', requests: [
    { attribute: { id: 'a', name: 'A' }, candidates: [candidate('one', 'One')] },
    { attribute: { id: 'b', name: 'B' }, candidates: [candidate('two', 'Two')] }
  ], runs: [{ rows: [{ id: 'a', reference: 'one', suggestion: { attrIdent: 'one' } }] }] }] }
  const dataset = prepareHistoricalDataset([{ source: 'fixture', document }])
  assert.equal(dataset.cases.length, 2)
  assert.equal(dataset.cases[0].candidates.length, 2)
  assert.equal(dataset.cases[0].label.status, 'pending')
  assert.deepEqual(dataset.cases[0].label.expectedAttrIdents, [])
  assert.equal(dataset.cases[0].reference, 'one')
  assert.equal(dataset.cases[0].poolComplete, false)
})

test('experiment compares all three modes with same eligible pool and no LLM call', async () => {
  const { compareDataset } = experiment()
  const dataset = { version: 1, scope: 'fixture', language: 'ru', cases: [{ id: 'x', category: 'c', attribute: { id: 'x', name: 'Country' }, candidates: [{ attrIdent: 'country', name: 'Origin', group: 'Main', type: 1, dictionary: false }], poolComplete: true, label: { status: 'confirmed', expectedAttrIdents: ['country'], reviewer: 'unit-test-fixture' } }] }
  const client = { stats: {}, describeModel: async () => ({ model: 'fake-test-only', digest: 'test' }), embed: async texts => texts.map(() => [1, 0]) }
  const result = await compareDataset(dataset, client)
  assert.deepEqual(result.rows[0].rankings, { lexical: ['country'], semantic: ['country'], hybrid: ['country'] })
  assert.equal(result.evaluation.metrics.hybrid.recallAt30, 1)
  assert.equal(result.finalLLMEvaluated, false)
})

test('dataset validation refuses duplicate cases/candidates and unreviewed positive labels', async () => {
  const { validateDataset } = experiment()
  const row = { id: 'x', category: 'c', attribute: { id: 'x', name: 'Country' }, candidates: [{ attrIdent: 'a', name: 'A', group: '', type: 1, dictionary: false }], poolComplete: true, label: { status: 'confirmed', expectedAttrIdents: ['a'], reviewer: 'test' } }
  const base = { version: 1, scope: 'fixture', language: 'ru', cases: [row] }
  assert.throws(() => validateDataset({ ...base, cases: [row, row] }), /duplicate/i)
  assert.throws(() => validateDataset({ ...base, cases: [{ ...row, candidates: [...row.candidates, ...row.candidates] }] }), /duplicate/i)
  assert.throws(() => validateDataset({ ...base, cases: [{ ...row, label: { ...row.label, reviewer: '' } }] }), /reviewer/i)
})

test('full snapshot preparation builds complete filtered pools before truncation', () => {
  const { prepareSnapshotDataset, validateDataset } = experiment()
  const dataset = prepareSnapshotDataset({ tenantId: 't', language: 'ru', groups: [{ visible: true, name: 'Main', attributes: [
    { identifier: 'source', name: 'Country', valid: [1], type: 1 }, { identifier: 'excluded', name: 'Country', valid: [2], type: 1 }
  ] }], categories: [{ id: 'c', name: 'Category', valid: [1], attributes: [{ id: 'x', name: 'Country' }] }] })
  validateDataset(dataset)
  assert.equal(dataset.scope, 't')
  assert.equal(dataset.cases[0].poolComplete, true)
  assert.deepEqual(dataset.cases[0].candidates.map(row => row.attrIdent), ['source'])
  assert.equal(dataset.cases[0].label.status, 'pending')
})

test('historical review retains bounded value examples on both sides without copying private fields', () => {
  const { prepareHistoricalDataset } = experiment()
  const options = { status: 'loaded', examples: ['газ', 'электричество'], total: 15, truncated: true, sharedByAttributes: 901, headers: { secret: 'do-not-copy' } }
  const data = prepareHistoricalDataset([{ source: 'fixture', document: { categories: [{ id: 'c', requests: [{ attribute: { id: 'x', name: 'Fuel', valueOptions: options }, candidates: [{ attrIdent: 'fuel', name: 'Fuel', group: 'Main', type: 7, valueOptions: options }] }] }] } }])
  assert.deepEqual(data.cases[0].attribute.valueOptions.examples, options.examples)
  assert.equal(data.cases[0].candidates[0].valueOptions.sharedByAttributes, 901)
  assert.equal(JSON.stringify(data).includes('do-not-copy'), false)
})
