const { test } = require('node:test')
const assert = require('node:assert/strict')
const mapping = require('../src/channels/ai/mapping.ts')
const retrieval = () => require('../src/channels/ai/retrieval.ts')

test('full candidate pools retain eligibility and lexical30 remains the exact prefix', () => {
  const attributes = Array.from({ length: 40 }, (_, i) => ({ identifier: 'a' + i, name: 'Color ' + i, valid: [1], type: 1 }))
  attributes.push({ identifier: 'excluded', name: 'Color', valid: [2], type: 1 })
  const groups = [{ visible: true, name: 'Main', attributes }, { visible: false, attributes: [{ identifier: 'hidden', valid: [1] }] }]
  const target = [{ id: 'x', name: 'Color' }]
  const full = mapping.buildMappingCandidatePools(groups, target, 'ru', [1])
  assert.equal(full[0].candidates.length, 40)
  assert.deepEqual(mapping.buildMappingRequests(groups, target, 'ru', [1])[0].candidates, full[0].candidates.slice(0, 30))
  assert.equal(full[0].candidates.some(row => row.attrIdent === 'excluded' || row.attrIdent === 'hidden'), false)
})

test('semantic retrieval can recover an eligible source beyond the old top30; hybrid retains exact matches', () => {
  const { rankSemanticCandidates, rankHybridCandidates } = retrieval()
  const candidates = Array.from({ length: 35 }, (_, i) => ({ attrIdent: 'a' + i, name: 'Unrelated ' + i, group: '', type: 1, dictionary: false }))
  candidates[0].name = 'Country'
  const vectors = new Map(candidates.map((row, i) => [row.attrIdent, i === 34 ? [1, 0] : [0, 1]]))
  const semantic = rankSemanticCandidates(candidates, [1, 0], vectors)
  assert.equal(semantic[0].attrIdent, 'a34')
  const hybrid = rankHybridCandidates({ name: 'Country', id: 'x' }, candidates, semantic, 30)
  assert.equal(hybrid[0].attrIdent, 'a0')
  assert.ok(hybrid.some(row => row.attrIdent === 'a34'))
  assert.equal(hybrid.length, 30)
  assert.equal(new Set(hybrid.map(row => row.attrIdent)).size, 30)
})

test('invalid/missing/nonfinite/zero and mismatched vectors fail closed', () => {
  const { rankSemanticCandidates } = retrieval()
  for (const vector of [[0, 0], [NaN, 1], [1], undefined]) assert.throws(() => rankSemanticCandidates([{ attrIdent: 'x' }], [1, 0], new Map([['x', vector]])), /vector/i)
})

test('retrieval metrics exclude pending labels and require full pools for quality claims', () => {
  const { evaluateRetrieval } = retrieval()
  const rows = [
    { label: { status: 'confirmed', expectedAttrIdents: ['b'] }, rankings: { lexical: ['a','b'], semantic: ['b','a'], hybrid: ['a','b'] }, poolComplete: true, candidates: [{ attrIdent: 'a' }, { attrIdent: 'b' }] },
    { label: { status: 'pending', expectedAttrIdents: ['a'] }, rankings: { lexical: ['a'], semantic: ['a'], hybrid: ['a'] }, poolComplete: true, candidates: [{ attrIdent: 'a' }] }
  ]
  const result = evaluateRetrieval(rows)
  assert.equal(result.confirmedPositives, 1)
  assert.equal(result.pending, 1)
  assert.equal(result.metrics.lexical.mrrAt30, .5)
  assert.equal(result.metrics.semantic.mrrAt30, 1)
  assert.equal(result.metrics.lexical.recallAt30, 1)
  assert.equal(evaluateRetrieval(rows.map(row => ({ ...row, poolComplete: false }))).metrics, null)
})

test('MRR@30 explicitly treats an expected match at rank35 as a retrieval miss', () => {
  const { evaluateRetrieval } = retrieval()
  const candidates = Array.from({ length: 35 }, (_, i) => ({ attrIdent: 'a' + i }))
  const ranking = candidates.map(row => row.attrIdent)
  const result = evaluateRetrieval([{ poolComplete: true, candidates, label: { status: 'confirmed', expectedAttrIdents: ['a34'] }, rankings: { lexical: ranking, semantic: ranking, hybrid: ranking } }])
  assert.equal(result.metrics.lexical.mrrAt30, 0)
  assert.equal(result.metrics.lexical.recallAt30, 0)
})
