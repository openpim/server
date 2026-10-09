const test = require('node:test')
const assert = require('node:assert/strict')
const { selectSpecificAttributes } = require('../scripts/ai-mapping/specific-selection.cjs')

test('specific selection prioritises required fields and excludes previously tested service fields', () => {
  const live = [
    { id: 'a', name: 'Название группы вариантов', required: false },
    { id: 'b', name: 'Количество конфорок', required: false },
    { id: 'c', name: 'Материал панели', required: true },
    { id: 'd', name: 'Количество скоростей', required: false },
  ]
  const stored = live.map(row => ({ id: row.id }))
  assert.deepEqual(selectSpecificAttributes('237418', live, stored, ['a'], 2).map(row => row.id), ['c', 'b'])
})

test('specific selection excludes expressions, duplicates, deleted or absent rows and unrelated fields', () => {
  const live = ['expr', 'dup', 'deleted', 'missing', 'good'].map(id => ({ id, name: 'Мощность вытяжки', required: false }))
  const stored = [{ id: 'expr', expr: 'return 1' }, { id: 'dup' }, { id: 'dup' }, { id: 'deleted', deleted: true }, { id: 'good' }]
  assert.deepEqual(selectSpecificAttributes('70103401', live, stored, [], 15).map(row => row.id), ['good'])
  assert.throws(() => selectSpecificAttributes('unknown', live, stored, [], 15), /category/)
})

test('required eligible fields remain selected even when not covered by category themes', () => {
  const live = [{ id: 'mandatory', name: 'Новый обязательный признак', required: true }, { id: 'irrelevant', name: 'Название группы вариантов' }]
  const stored = live.map(row => ({ id: row.id }))
  assert.deepEqual(selectSpecificAttributes('90580', live, stored, [], 15).map(row => row.id), ['mandatory'])
})

test('selection covers different themes instead of letting burner variants consume the whole batch', () => {
  const live = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: 'burner' + i, name: 'Конфорок ' + i })),
    { id: 'material', name: 'Материал панели' },
    { id: 'power', name: 'Мощность подключения' }
  ]
  const selected = selectSpecificAttributes('237418', live, live.map(row => ({ id: row.id })), [], 3)
  assert.deepEqual(selected.map(row => row.id), ['burner0', 'material', 'power'])
})
