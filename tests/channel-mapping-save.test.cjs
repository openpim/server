const { test } = require('node:test')
const assert = require('node:assert/strict')
const { updateChannelMappings } = require('../src/resolvers/import/channels.ts')
const context = { getCurrentUser: () => ({ login: 'editor' }) }
const base = () => ({ id: 'a', name: 'A', updatedAt: '2026-10-09T10:00:00.000Z', attributes: [{ id: 'x', expr: '1' }] })

test('mapping save preserves input and stamps accepted revision instead of mutating the draft', () => {
  const old = base()
  const draft = { ...base(), changed: true, _expectedUpdatedAt: old.updatedAt, attributes: [{ id: 'x', expr: '2' }] }
  const before = JSON.stringify(draft)
  const conflicts = []
  const saved = updateChannelMappings(context, { type: 3, mappings: { a: old } }, { a: draft }, conflicts)
  assert.deepEqual(conflicts, [])
  assert.equal(saved.a.attributes[0].expr, '2')
  assert.equal(JSON.stringify(draft), before)
  assert.equal(saved.a.changed, undefined)
  assert.equal(saved.a._expectedUpdatedAt, undefined)
})

test('versioned Yandex stale draft cannot overwrite another editor and unmodified categories stay current', () => {
  const current = { ...base(), updatedAt: '2026-10-09T11:00:00.000Z', attributes: [{ id: 'x', expr: 'fresh' }] }
  const stale = { ...base(), changed: true, _expectedUpdatedAt: base().updatedAt, attributes: [{ id: 'x', expr: 'stale' }] }
  const conflicts = []
  const saved = updateChannelMappings(context, { type: 9, mappings: { a: current } }, { a: stale }, conflicts)
  assert.equal(saved.a.attributes[0].expr, 'fresh')
  assert.deepEqual(conflicts, ['A'])
  const untouched = updateChannelMappings(context, { type: 9, mappings: { a: current } }, { a: { ...stale, changed: false } }, [])
  assert.equal(untouched.a.attributes[0].expr, 'fresh')
})

test('versioned deletions and concurrently created categories are checked against the stored revision', () => {
  const conflicts = []
  const old = base()
  const saved = updateChannelMappings(context, { type: 2, mappings: { a: old } }, { a: { deleted: true, _expectedUpdatedAt: null } }, conflicts)
  assert.deepEqual(saved.a, old)
  assert.deepEqual(conflicts, ['A'])
  const created = updateChannelMappings(context, { type: 3, mappings: {} }, { a: { id: 'a', name: 'A', changed: true, _expectedUpdatedAt: null, attributes: [] } }, [])
  assert.equal(created.a.id, 'a')
  assert.ok(created.a.updatedAt)
})

test('versioned general Yandex rules also reject stale writes and retain unchanged current rules', () => {
  const old = base()
  const conflicts = []
  const channel = { type: 9, mappings: { _default: old } }
  const result = updateChannelMappings(context, channel, { _default: { ...old, changed: true, _expectedUpdatedAt: null } }, conflicts)
  assert.deepEqual(conflicts, ['A'])
  assert.deepEqual(result._default, old)
})
