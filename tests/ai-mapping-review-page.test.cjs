const { test } = require('node:test')
const assert = require('node:assert/strict')

test('review page serializes metadata as inert JSON and exports only human labels by case id', () => {
  const { reviewDataset, renderReviewPage } = require('../scripts/ai-mapping/retrieval-review-page.cjs')
  const report = { scope: 't', language: 'ru', provenance: { model: 'bge-m3' }, rows: [{ id: 'x', categoryName: 'Category', category: 'c', poolComplete: false, source: 'fixture', attribute: { id: 'x', name: '</script><img src=x onerror=alert(1)>' }, candidates: [{ attrIdent: 'a', name: 'A', group: '', type: 1 }], rankings: { lexical: ['a'], semantic: ['a'], hybrid: ['a'] }, label: { status: 'pending', expectedAttrIdents: [], reviewer: '', notes: '' }, config: { apiKey: 'must-not-copy' } }] }
  const dataset = reviewDataset(report)
  assert.equal(dataset.cases[0].config, undefined)
  const html = renderReviewPage(report)
  assert.equal(html.includes('</script><img'), false)
  assert.equal(html.includes('must-not-copy'), false)
  assert.ok(html.includes('application/json'))
  assert.ok(html.includes('Сохранить JSON'))
})

test('adding display value examples preserves the browser review storage key', () => {
  const { renderReviewPage } = require('../scripts/ai-mapping/retrieval-review-page.cjs')
  const report = { scope: 't', language: 'ru', provenance: { model: 'bge' }, rows: [{ id: 'x', category: 'c', attribute: { id: 'x', name: 'Fuel' }, candidates: [{ attrIdent: 'a', name: 'A', group: '', type: 7 }], poolComplete: false, label: { status: 'pending', expectedAttrIdents: [], reviewer: '', notes: '' }, rankings: { lexical: ['a'], semantic: ['a'], hybrid: ['a'] } }] }
  const checksum = html => JSON.parse(html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)[1]).checksum
  const before = checksum(renderReviewPage(report))
  report.rows[0].attribute.valueOptions = { status: 'loaded', examples: ['газ'] }
  report.rows[0].candidates[0].valueOptions = { status: 'loaded', examples: ['газ'], sharedByAttributes: 901 }
  assert.equal(checksum(renderReviewPage(report)), before)
})
