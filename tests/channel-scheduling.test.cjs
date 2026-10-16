const { test } = require('node:test')
const assert = require('node:assert/strict')
require('../src/models/manager.ts')
const { ChannelsManager } = require('../src/channels/index.ts')

test('stopping or grouping a channel cancels both schedules without resetting in-flight flags', () => {
  for (const operation of ['stop', 'group']) {
    const manager = new ChannelsManager('test')
    const canceled = []
    manager.jobMap = { c: [{ cancel: () => canceled.push('main') }, true], c_sync: [{ cancel: () => canceled.push('sync') }, true] }
    const channel = { identifier: 'c', group: operation === 'group' }
    if (operation === 'stop') manager.stopChannel(channel)
    else manager.startChannel(channel)
    assert.deepEqual(canceled, ['main', 'sync'])
    assert.equal(manager.jobMap.c[1], true)
    assert.equal(manager.jobMap.c_sync[1], true)
  }
})

test('restarting scheduling retains the in-flight tuple used by job completion', () => {
  const previous = process.env.OPENPIM_NO_CHANNEL_SCHEDULER
  process.env.OPENPIM_NO_CHANNEL_SCHEDULER = 'false'
  try {
    const manager = new ChannelsManager('test')
    const main = [null, true], sync = [null, true]
    manager.jobMap = { c: main, c_sync: sync }
    manager.startChannel({ identifier: 'c', active: true, config: {} })
    assert.equal(manager.jobMap.c, main)
    assert.equal(manager.jobMap.c_sync, sync)
    assert.equal(main[1], true)
    assert.equal(sync[1], true)
    main[1] = false
    assert.equal(manager.jobMap.c[1], false)
  } finally {
    if (previous === undefined) delete process.env.OPENPIM_NO_CHANNEL_SCHEDULER
    else process.env.OPENPIM_NO_CHANNEL_SCHEDULER = previous
  }
})
