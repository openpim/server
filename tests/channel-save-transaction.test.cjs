const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ModelsManager } = require('../src/models/manager.ts')
const models = require('../src/models/index.ts')
const { Channel } = require('../src/models/channels.ts')
const { ChannelsManagerFactory } = require('../src/channels/index.ts')
const resolver = require('../src/resolvers/channels.ts').default

test('channel SAVE locks a fresh row and rejects all conflicts before writing or changing cache', async () => {
  const cached = { id: 1, tenantId: 't', identifier: 'c', type: 9, name: { ru: 'Old' }, mappings: {} }
  const fresh = { ...cached, mappings: { a: { id: 'a', name: 'A', updatedAt: 'fresh', attributes: [] } } }
  let writes = 0, locked = false
  fresh.save = async () => { writes++ }
  const manager = { getChannels: () => [cached], getTenantId: () => 't' }
  const context = { checkAuth() {}, canEditConfig: () => true, canViewChannel: () => true, canEditChannel: () => true, getCurrentUser: () => ({ tenantId: 't', login: 'editor' }), getUserToken: () => '' }
  const originals = [ModelsManager.getInstance, models.sequelize, Channel.applyScope, ChannelsManagerFactory.getInstance]
  ModelsManager.getInstance = () => ({ getModelManager: () => manager })
  models.sequelize = { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) }
  Channel.applyScope = () => ({ findOne: async options => { locked = options.lock === 'UPDATE' && !!options.transaction; return fresh } })
  ChannelsManagerFactory.getInstance = () => { throw new Error('Must not notify on rejected SAVE') }
  try {
    await assert.rejects(resolver.Mutation.updateChannel(null, { id: '1', name: { ru: 'New' }, mappings: { a: { changed: true, _expectedUpdatedAt: 'old', attributes: [] } } }, context), /conflict/i)
    assert.equal(locked, true)
    assert.equal(writes, 0)
    assert.deepEqual(cached.name, { ru: 'Old' })
    assert.deepEqual(cached.mappings, {})
  } finally {
    ;[ModelsManager.getInstance, models.sequelize, Channel.applyScope, ChannelsManagerFactory.getInstance] = originals
  }
})

test('accepted SAVE publishes only after commit; validation/DB failures leave cache and draft intact', async () => {
  const originals = [ModelsManager.getInstance, models.sequelize, Channel.applyScope, ChannelsManagerFactory.getInstance]
  try {
    for (const mode of ['success', 'invalid', 'database']) {
      const cached = { id: 1, tenantId: 't', identifier: 'c', type: 3, active: false, config: {}, mappings: {} }
      const rows = [cached]
      let committed = false, writes = 0, notifications = 0
      const fresh = { ...cached, save: async () => { writes++; if (mode === 'database') throw new Error('DB failed') } }
      const manager = { getChannels: () => rows, reloadModelRemotely: async () => { notifications++; assert.equal(committed, true) } }
      const context = { checkAuth() {}, canEditConfig: () => true, canViewChannel: () => true, canEditChannel: () => true, getCurrentUser: () => ({ tenantId: 't', login: 'editor' }), getUserToken: () => '' }
      ModelsManager.getInstance = () => ({ getModelManager: () => manager })
      models.sequelize = { transaction: async fn => { const result = await fn({ LOCK: { UPDATE: 'UPDATE' } }); assert.equal(rows[0], cached); committed = true; return result } }
      Channel.applyScope = () => ({ findOne: async () => fresh })
      ChannelsManagerFactory.getInstance = () => ({ getChannelsManager: () => ({ stopChannel: () => assert.equal(committed, true) }) })
      const mappings = { a: { id: 'a', name: 'A', changed: true, _expectedUpdatedAt: null, attributes: [{ id: 'x', expr: mode === 'invalid' ? 'process.env' : 'item.values.x ?? 0' }] } }
      const before = JSON.stringify(mappings)
      const operation = resolver.Mutation.updateChannel(null, { id: '1', mappings }, context)
      if (mode === 'success') {
        assert.equal(await operation, 1)
        assert.equal(rows[0], fresh)
        assert.equal(rows[0].mappings.a.changed, undefined)
        assert.equal(notifications, 1)
      } else {
        await assert.rejects(operation, mode === 'invalid' ? /not allowed/ : /DB failed/)
        assert.equal(rows[0], cached)
        assert.equal(notifications, 0)
        assert.equal(writes, mode === 'invalid' ? 0 : 1)
      }
      assert.equal(JSON.stringify(mappings), before)
    }
  } finally { [ModelsManager.getInstance, models.sequelize, Channel.applyScope, ChannelsManagerFactory.getInstance] = originals }
})

test('preview is tenant-authorized, typed and cannot perform database lookups', async () => {
  const original = ModelsManager.getInstance
  const channel = { id: 1, identifier: 'c', tenantId: 't', type: 9 }
  ModelsManager.getInstance = () => ({ getModelManager: () => ({ getChannels: () => [channel] }) })
  const context = { checkAuth() {}, canEditConfig: () => true, canViewChannel: () => true, canEditChannel: () => true, getCurrentUser: () => ({ tenantId: 't' }) }
  try {
    for (const [expression, valueType, value] of [['null','null',null],['undefined','undefined',null],['[1]','array',[1]],['({a:1})','object',{a:1}],['item.values.x + 1','number',3]]) {
      const result = await resolver.Query.previewChannelMappingExpression(null, { channelId: '1', expression, sample: { item: { values: { x: 2 } } } }, context)
      assert.equal(result.ok, true)
      assert.equal(result.valueType, valueType)
      assert.deepEqual(result.value, value)
    }
    const lookup = await resolver.Query.previewChannelMappingExpression(null, { channelId: '1', expression: 'await utils.getItem("x")', sample: {} }, context)
    assert.equal(lookup.ok, false)
    await assert.rejects(resolver.Query.validateChannelMappingExpression(null, { channelId: '1', expression: '1' }, { ...context, getCurrentUser: () => ({ tenantId: 'another' }) }), /not found/)
    await assert.rejects(resolver.Query.previewChannelMappingExpression(null, { channelId: '1', expression: '1', sample: {} }, { ...context, canEditChannel: () => false }), /permissions/)
  } finally { ModelsManager.getInstance = original }
})

test('published GraphQL schema executes the exact client validation and preview contracts', async () => {
  const { graphql } = require('graphql')
  const { makeExecutableSchema } = require('@graphql-tools/schema')
  const { GraphQLJSONObject } = require('graphql-type-json')
  const { loadSchemaTypeDefs } = require('../src/graphql/schemaLoader.ts')
  const path = require('node:path')
  const typeDefs = await loadSchemaTypeDefs(path.join(__dirname, '../schema/index.graphql'))
  const schema = makeExecutableSchema({ typeDefs, resolvers: { JSONObject: GraphQLJSONObject, Query: { validateChannelMappingExpression: resolver.Query.validateChannelMappingExpression, previewChannelMappingExpression: resolver.Query.previewChannelMappingExpression } } })
  const original = ModelsManager.getInstance
  ModelsManager.getInstance = () => ({ getModelManager: () => ({ getChannels: () => [{ id: 1, identifier: 'c', tenantId: 't', type: 9 }] }) })
  const contextValue = { checkAuth() {}, canEditConfig: () => true, canViewChannel: () => true, canEditChannel: () => true, getCurrentUser: () => ({ tenantId: 't' }) }
  try {
    const validation = await graphql({ schema, contextValue, source: 'query($channelId: ID!, $expression: String!) { validateChannelMappingExpression(channelId: $channelId, expression: $expression) }', variableValues: { channelId: '1', expression: 'item.values.x + 1' } })
    assert.equal(validation.errors, undefined)
    assert.equal(validation.data.validateChannelMappingExpression.valid, true)
    const preview = await graphql({ schema, contextValue, source: 'query($channelId: ID!, $expression: String!, $sample: JSONObject!) { previewChannelMappingExpression(channelId: $channelId, expression: $expression, sample: $sample) }', variableValues: { channelId: '1', expression: 'item.values.x + 1', sample: { item: { values: { x: 2 } } } } })
    assert.equal(preview.errors, undefined)
    assert.deepEqual(preview.data.previewChannelMappingExpression, { ok: true, diagnostic: { valid: true }, valueType: 'number', value: 3 })
  } finally { ModelsManager.getInstance = original }
})
