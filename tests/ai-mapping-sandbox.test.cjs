const test = require('node:test')
const assert = require('node:assert/strict')
const { prepareCategory, applySuggestions, selectCandidateGroups, experimentCategory } = require('../scripts/ai-mapping/sandbox-data.cjs')

test('experiment category is allowlisted and default keeps historical output identity', () => {
  assert.equal(experimentCategory().slug, 'grill')
  assert.equal(experimentCategory('15450095').name, 'Винные шкафы')
  assert.throws(() => experimentCategory('unknown'), /category/)
})

test('group restriction is exact and fails closed for absent or ambiguous groups', () => {
  const groups = [{ identifier: 'mainAttrGroup', attributes: [{ identifier: 'erp' }] },
    { identifier: 'market', attributes: [{ identifier: 'market_copy' }] }]
  assert.deepEqual(selectCandidateGroups(groups, 'mainAttrGroup'), [groups[0]])
  assert.deepEqual(selectCandidateGroups(groups, null), groups)
  assert.throws(() => selectCandidateGroups(groups, 'missing'), /group/)
  assert.throws(() => selectCandidateGroups([...groups, groups[0]], 'mainAttrGroup'), /group/)
})

test('copy empties only evaluated rows and preserves expressions, visibility and source', () => {
  const source = { id: '1', name: 'Category', visible: ['42'], visibleRelation: 38, attributes: [
    { id: 'a', attrIdent: 'old', expr: '', useYandexOnUpdate: true },
    { id: 'b', attrIdent: 'manual', expr: 'return 1' },
    { id: '#sku', attrIdent: 'sku' }
  ] }
  const original = JSON.stringify(source)
  const copy = prepareCategory(source, ['a'])
  assert.equal(copy.attributes[0].attrIdent, '')
  assert.equal(copy.attributes[0].useYandexOnUpdate, true)
  assert.equal(copy.attributes[1].expr, 'return 1')
  assert.equal(copy.attributes[2].attrIdent, 'sku')
  assert.deepEqual(copy.visible, ['42'])
  assert.equal(copy.visibleRelation, 38)
  assert.equal(JSON.stringify(source), original)
  assert.throws(() => prepareCategory(source, ['b']), /eligible/)
  assert.throws(() => prepareCategory(source, ['#sku']), /eligible/)
})

test('apply rejects out-of-scope or non-shortlisted results before any change', () => {
  const category = { attributes: [{ id: 'a', attrIdent: '', expr: '' }, { id: 'b', attrIdent: 'manual' }] }
  const requests = [{ attribute: { id: 'a' }, candidates: [{ attrIdent: 'color' }] }]
  const original = JSON.stringify(category)
  assert.throws(() => applySuggestions(category, requests, [{ id: 'b', attrIdent: 'color' }]), /scope/)
  assert.throws(() => applySuggestions(category, requests, [{ id: 'a', attrIdent: 'unknown' }]), /candidate/)
  assert.throws(() => applySuggestions(category, requests, [{ id: 'a', attrIdent: 'color' }, { id: 'a', attrIdent: null }]), /duplicate/)
  assert.equal(JSON.stringify(category), original)
  const copy = applySuggestions(category, requests, [{ id: 'a', attrIdent: 'color', needsReview: true }])
  assert.equal(copy.attributes[0].attrIdent, 'color')
  assert.equal(copy.attributes[1].attrIdent, 'manual')
  assert.equal(JSON.stringify(category), original)
})
