const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

function reviewDataset (report) {
  return { version: 1, scope: report.scope, language: report.language,
    limitation: 'Historical candidate pools are incomplete; confirmed human labels do not make the pools complete.',
    cases: report.rows.map(row => ({ id: row.id, category: row.category, categoryName: row.categoryName, attribute: row.attribute,
      candidates: row.candidates, poolComplete: row.poolComplete, source: row.source, historicalPoolSize: row.historicalPoolSize,
      reference: row.reference, label: row.label })) }
}

function renderReviewPage (report) {
  const dataset = reviewDataset(report)
  // Value samples are display-only: preserve existing human drafts when adding them.
  const storageDataset = JSON.parse(JSON.stringify(dataset))
  for (const row of storageDataset.cases) {
    delete row.attribute.valueOptions
    for (const candidate of row.candidates) delete candidate.valueOptions
  }
  const checksum = createHash('sha256').update(JSON.stringify(storageDataset)).digest('hex')
  const serialized = JSON.stringify({ dataset, checksum, model: report.provenance.model,
    rankings: Object.fromEntries(report.rows.map(row => [row.id, row.rankings])) })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return fs.readFileSync(path.join(__dirname, 'retrieval-review-template.html'), 'utf8').replace('__REVIEW_DATA__', serialized)
}

module.exports = { reviewDataset, renderReviewPage }
if (require.main === module) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output || path.resolve(input) === path.resolve(output)) throw new Error('Pass distinct report JSON and output HTML paths.')
  fs.writeFileSync(output, renderReviewPage(JSON.parse(fs.readFileSync(input, 'utf8'))))
}
