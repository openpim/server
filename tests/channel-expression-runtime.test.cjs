const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ModelsManager } = require('../src/models/manager.ts')
const { ChannelHandler } = require('../src/channels/ChannelHandler.ts')
const handler = new ChannelHandler()
const channel = { tenantId: 'test', identifier: 'test', config: {} }
const item = { id: 1, tenantId: 'test', name: { ru: 'Name' }, values: { title: { ru: 'Title' } } }

test('localized direct mapping looks up its base attribute instead of its language-qualified ID', async t => {
  const original = ModelsManager.getInstance
  ModelsManager.getInstance = () => ({ getModelManager: () => ({ getAttributeByIdentifier: id => id === 'title' ? { attr: { type: 1 } } : null }) })
  t.after(() => { ModelsManager.getInstance = original })
  assert.equal(await handler.getValueByMapping2(channel, { attrIdent: 'title#ru' }, item, 'ru', null), 'Title')
  assert.equal(await handler.getValueByMapping2(channel, { attrIdent: 'title#en' }, item, 'ru', null), undefined)
  assert.equal(await handler.getValueByMapping2(channel, { attrIdent: '$name#ru' }, item, 'ru', null), 'Name')
})

test('mapping expressions cannot access Node globals or escape through constructors', async () => {
  for (const expr of ['process', 'globalThis', 'item.constructor.constructor("return process")()', '({}).__proto__', 'utils.getCache()', 'channel.config.apiKey']) {
    await assert.rejects(handler.evaluateExpression2(channel, item, expr, null), /not allowed|Unknown|forbidden|unavailable/i)
  }
})

test('localized LOV and relation mappings use the selected suffix language; null stays explicit', async t => {
  const utils = require('../src/resolvers/utils.ts')
  const originals = [ModelsManager.getInstance, utils.checkLOV, utils.checkRelationAttrDisplayValue]
  ModelsManager.getInstance = () => ({ getModelManager: () => ({ getAttributeByIdentifier: id => ({ attr: { type: id === 'lov' ? 7 : 9 } }) }) })
  utils.checkLOV = async (_channel, _attr, value, lang) => `${lang}:${value}`
  utils.checkRelationAttrDisplayValue = async (_tenant, _attr, value, lang) => `${lang}:${value}`
  t.after(() => { [ModelsManager.getInstance, utils.checkLOV, utils.checkRelationAttrDisplayValue] = originals })
  const sample = { ...item, values: { lov: { en: 2 }, relation: { en: 3 }, title: null } }
  assert.equal(await handler.getValueByMapping2(channel, { attrIdent: 'lov#en' }, sample, 'ru', null), 'en:2')
  assert.equal(await handler.getValueByMapping2(channel, { attrIdent: 'relation#en' }, sample, 'ru', null), 'en:3')
})

test('expression lookups keep tenant predicates, bounded rows and a local SQL deadline', async t => {
  const models = require('../src/models/index.ts')
  const { Item } = require('../src/models/items.ts')
  const { ItemRelation } = require('../src/models/itemRelations.ts')
  const originals = [models.sequelize, Item.findAll, ItemRelation.findAll]
  const transaction = { id: 'mock-transaction' }
  let deadlineCalls = 0, queries = 0
  models.sequelize = {
    transaction: async fn => fn(transaction),
    query: async (sql, options) => {
      assert.equal(options.transaction, transaction)
      if (sql.startsWith('SET LOCAL')) { deadlineCalls++; assert.match(sql, /2000ms/); return [] }
      queries++
      assert.match(sql, /LIMIT :resultLimit/)
      assert.match(sql, /r\."tenantId"=:tenant/)
      assert.equal(options.replacements.tenant, 'test')
      assert.equal(options.replacements.resultLimit, 1)
      return [{ id: 5 }]
    }
  }
  Item.findAll = async options => {
    queries++
    assert.equal(options.transaction, transaction)
    assert.equal(options.limit, 100)
    const { Op } = require('sequelize')
    assert.deepEqual(options.where[Op.and][1], { tenantId: 'test' })
    return [{ id: 5 }]
  }
  ItemRelation.findAll = async options => {
    queries++
    assert.equal(options.limit, 100)
    assert.equal(options.transaction, transaction)
    assert.equal(options.where.tenantId, 'test')
    return [{ id: 6 }]
  }
  t.after(() => { [models.sequelize, Item.findAll, ItemRelation.findAll] = originals })
  await assert.rejects(handler.evaluateExpression2(channel, item, 'await utils.findItems({name:"###:unsafe"})', null), /Raw SQL/)
  assert.equal(queries, 0)
  assert.deepEqual(await handler.evaluateExpression2(channel, item, 'await utils.findItems({tenantId:"other"})', null), [{ id: 5 }])
  assert.deepEqual(await handler.evaluateExpression2(channel, item, 'await utils.getTargetRelations("r")', null), [{ id: 6 }])
  assert.deepEqual(await handler.evaluateExpression2(channel, item, 'await utils.getTargetObject("r", false)', null), { id: 5 })
  assert.equal(deadlineCalls, 3)
})
