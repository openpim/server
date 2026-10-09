const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DnsChannelHandler } = require('../src/channels/dns/DnsChannelHandler.ts')

// The developer environment may enable emulation; transport below never contacts DNS.
process.env.OPENPIM_DNS_EMULATION = 'false'

const DNS_ID = '4d4923ba-6d00-4b87-8b97-fd1bbceaf636'
const PRODUCT_PATH = '/products/' + DNS_ID
const MODEL_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function response(status, json = null) {
  return { status, json, text: json ? JSON.stringify(json) : '', headers: { get: () => null } }
}

function remoteProduct(stage) {
  return {
    id: DNS_ID, manufacturerBarcode: '4601234567890', article: 'M186', name: 'Logitech M186',
    stage, approvedSubStatus: stage === 'Approved' ? 'Selling' : null, errorKind: null,
    rejectionComment: stage === 'Rejected' ? 'Удалить null из модели' : null,
    mdmNomenclatureCode: null, files: [], createdAt: '2026-10-07T07:00:00Z', businessDetails: null
  }
}

function editResource(editRevision = 'rejection-correction:42:3') {
  return {
    editRevision, specOptionValues: { [MODEL_ID]: 'Logitech null M186' },
    media: [], mainPhotoUrl: 'https://cdn.example.com/old.jpg', description: '',
    complianceDocumentUrls: [], operatingDocumentUrls: [], article: 'M186'
  }
}

function fixture({ stage = 'Rejected', existing = true, readStatus = 200, editStatus = 200, putStatus = 200, revision = 'rejection-correction:42:3' } = {}) {
  const handler = new DnsChannelHandler()
  const channel = { identifier: 'dns', tenantId: 'tenant', config: { dnsIdAttr: 'dnsId', dnsApiToken: 'test-only' } }
  const values = {
    name: 'Logitech M186', salePrice: 1000, mpn: 'M186', article: 'M186', manufacturerBarcode: '4601234567890',
    warrantyMonths: 12, packageLengthCm: 10, packageWidthCm: 6, packageHeightCm: 4, netWeightKg: 0.1,
    tnvedCode: '8471607000', okpd2Code: '26.20.16.170', mainPhotoUrl: 'https://cdn.example.com/main.jpg',
    photoUrls: ['https://cdn.example.com/1.jpg'], richPhotoUrls: ['https://cdn.example.com/rich.jpg'],
    brand: 'Logitech', country: 'CN', model: 'Logitech M186', dnsId: existing ? DNS_ID : ''
  }
  const item = { id: 1372792, identifier: '1372792', tenantId: 'tenant', values, channels: { dns: { status: 1, dnsError: true } }, changed() {} }
  const attributes = Object.keys(values).filter(key => !['brand', 'country', 'model', 'dnsId'].includes(key))
    .map(key => ({ id: '#' + key, expr: 'item.values.' + key }))
  attributes.push({ id: 'dnsbrand', expr: 'item.values.brand' }, { id: 'dnscountry', expr: 'item.values.country' },
    { id: 'dnsattr_' + MODEL_ID, expr: 'item.values.model' })
  const category = { id: 'dnsclass_class_spec_spec', name: 'Мышь', attributes }
  const context = { log: '' }
  const requests = []
  handler.getAttributes = async () => [{ id: 'dnsattr_' + MODEL_ID, name: 'Модель', dictionary: false }]
  handler.getChannelAttributeValues = async () => ({ values: [] })
  // Keep routing, mapping, retries and result handling real; replace only the external transport.
  handler.dnsRequest = async (_channel, _context, method, path, body, headers) => {
    requests.push({ method, path, body, headers })
    if (method === 'get' && path === PRODUCT_PATH) return response(readStatus, readStatus === 200 ? remoteProduct(stage) : { title: 'Status unavailable' })
    if (method === 'get' && path === PRODUCT_PATH + '/uniform') {
      if (editStatus !== 200) return response(editStatus, { title: 'Uniform unavailable' })
      return stage === 'Rejected'
        ? response(409, { type: 'https://seller.dns-shop.ru/problems/PRODUCT_UNIFORM_EDIT_NOT_ALLOWED' })
        : response(200, editResource('uniform:42:7'))
    }
    if (method === 'get' && path === PRODUCT_PATH + '/rejection-correction') return response(editStatus, editStatus === 200 ? editResource(revision) : { title: 'Correction unavailable' })
    if (method === 'put' && [PRODUCT_PATH + '/uniform', PRODUCT_PATH + '/rejection-correction'].includes(path)) {
      return response(putStatus, putStatus === 200 ? editResource() : { title: 'Revision conflict' })
    }
    if (method === 'post' && path === '/products') return response(201, { id: DNS_ID })
    throw Error('Unexpected DNS request: ' + method + ' ' + path)
  }
  return { handler, channel, item, category, context, requests, run: () => handler.processItemInCategory(channel, item, category, 'ru', context) }
}

test('rejected product saves mapped model through correction resource with its own revision', async () => {
  const f = fixture()
  await f.run()
  assert.deepEqual(f.requests.map(({ method, path }) => [method, path]), [
    ['get', PRODUCT_PATH], ['get', PRODUCT_PATH + '/rejection-correction'], ['put', PRODUCT_PATH + '/rejection-correction']
  ])
  const put = f.requests[2]
  assert.deepEqual(put.headers, { 'If-Product-Rejection-Correction-Revision': 'rejection-correction:42:3' })
  assert.deepEqual(put.body, {
    specOptionValues: { [MODEL_ID]: 'Logitech M186' },
    media: [{ type: 'Photo', url: 'https://cdn.example.com/1.jpg' }, { type: 'RichPhoto', url: 'https://cdn.example.com/rich.jpg' }],
    mainPhotoUrl: 'https://cdn.example.com/main.jpg'
  })
  assert.equal(f.item.channels.dns.dnsNeedsResubmission, true)
  assert.equal(f.item.channels.dns.dnsError, false)
  assert.match(f.item.channels.dns.message, /личном кабинете/)
  assert.match(f.context.log, /личном кабинете/)
})

test('approved product keeps uniform update with uniform revision and clears manual resubmission', async () => {
  const f = fixture({ stage: 'Approved' })
  f.item.channels.dns.dnsNeedsResubmission = true
  await f.run()
  assert.deepEqual(f.requests.map(({ method, path }) => [method, path]), [
    ['get', PRODUCT_PATH], ['get', PRODUCT_PATH + '/uniform'], ['put', PRODUCT_PATH + '/uniform']
  ])
  assert.deepEqual(f.requests[2].headers, { 'If-Product-Uniform-Revision': 'uniform:42:7' })
  assert.equal(f.item.channels.dns.dnsNeedsResubmission, false)
  assert.equal(f.item.channels.dns.status, 4)
})

test('new product is created without requesting an edit resource', async () => {
  const f = fixture({ existing: false })
  const changedValues = await f.run()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].method, 'post')
  assert.equal(f.requests[0].path, '/products')
  assert.equal(f.requests[0].body.name, 'Logitech M186')
  assert.equal(changedValues.dnsId, DNS_ID)
})

test('unavailable live status prevents writes rather than guessing an edit route', async () => {
  const f = fixture({ readStatus: 403 })
  await f.run()
  assert.deepEqual(f.requests.map(({ method, path }) => [method, path]), [['get', PRODUCT_PATH]])
  assert.equal(f.item.channels.dns.status, 3)
  assert.equal(f.item.channels.dns.dnsError, true)
})

test('failed correction does not mark edits saved or request resubmission', async () => {
  const f = fixture({ putStatus: 409 })
  f.item.channels.dns.dnsNeedsResubmission = true
  await f.run()
  assert.equal(f.item.channels.dns.status, 3)
  assert.equal(f.item.channels.dns.dnsError, true)
  assert.notEqual(f.item.channels.dns.dnsNeedsResubmission, true)
  assert.match(f.item.channels.dns.message, /Revision conflict/)
  assert.equal(f.requests.filter(r => r.method === 'put').length, 1)
})

test('failure reading correction resource stops before PUT and reports DNS error', async () => {
  const f = fixture({ editStatus: 403 })
  await f.run()
  assert.equal(f.requests.some(r => r.method === 'put'), false)
  assert.equal(f.item.channels.dns.status, 3)
  assert.equal(f.item.channels.dns.dnsError, true)
  assert.match(f.item.channels.dns.message, /Correction unavailable/)
})

test('an unrelated uniform conflict does not switch to rejection correction', async () => {
  const f = fixture({ stage: 'Approved', editStatus: 409 })
  await f.run()
  assert.equal(f.requests.some(r => r.path.endsWith('/rejection-correction')), false)
  assert.equal(f.requests.some(r => r.method === 'put'), false)
  assert.equal(f.item.channels.dns.status, 3)
  assert.match(f.item.channels.dns.message, /Uniform unavailable/)
})

test('missing correction revision prevents PUT', async () => {
  const f = fixture({ revision: '' })
  await f.run()
  assert.equal(f.requests.some(r => r.method === 'put'), false)
  assert.equal(f.item.channels.dns.status, 3)
  assert.match(f.item.channels.dns.message, /ревизи/)
})

test('correction emulation previews correct route without saving or marking resubmission', async t => {
  const f = fixture()
  const previous = process.env.OPENPIM_DNS_EMULATION
  process.env.OPENPIM_DNS_EMULATION = 'true'
  t.after(() => { if (previous === undefined) delete process.env.OPENPIM_DNS_EMULATION; else process.env.OPENPIM_DNS_EMULATION = previous })
  await f.run()
  assert.equal(f.requests.some(r => r.method === 'put' || r.method === 'post'), false)
  assert.match(f.context.log, /rejection-correction/)
  assert.notEqual(f.item.channels.dns.dnsNeedsResubmission, true)
})

test('status sync keeps manual resubmission notice until DNS leaves Rejected', () => {
  const f = fixture()
  Object.assign(f.item.channels.dns, { dnsNeedsResubmission: true, status: 4, message: 'Исправления сохранены в DNS. Отправьте товар на повторную модерацию в личном кабинете DNS.' })
  f.handler.processProductStatus(f.item, remoteProduct('Rejected'), f.channel, f.context)
  assert.equal(f.item.channels.dns.dnsNeedsResubmission, true)
  assert.match(f.item.channels.dns.message, /личном кабинете/)
  assert.equal(f.item.channels.dns.dnsError, false)
  f.handler.processProductStatus(f.item, remoteProduct('Review'), f.channel, f.context)
  assert.equal(f.item.channels.dns.dnsNeedsResubmission, false)
  assert.equal(f.item.channels.dns.status, 4)
  assert.equal(JSON.parse(f.item.channels.dns.message).stage, 'Review')
})

test('new rejection after resubmission is reported as an error', () => {
  const f = fixture()
  f.item.channels.dns.dnsNeedsResubmission = true
  f.handler.processProductStatus(f.item, remoteProduct('Review'), f.channel, f.context)
  f.handler.processProductStatus(f.item, remoteProduct('Rejected'), f.channel, f.context)
  assert.equal(f.item.channels.dns.dnsNeedsResubmission, false)
  assert.equal(f.item.channels.dns.status, 3)
  assert.equal(f.item.channels.dns.dnsError, true)
})

test('approval or blocking clears manual resubmission and uses actual DNS state', () => {
  for (const [stage, status, dnsError] of [['Approved', 2, false], ['Blocked', 3, true], ['Error', 3, true]]) {
    const f = fixture()
    f.item.channels.dns.dnsNeedsResubmission = true
    f.handler.processProductStatus(f.item, remoteProduct(stage), f.channel, f.context)
    assert.equal(f.item.channels.dns.dnsNeedsResubmission, false)
    assert.equal(f.item.channels.dns.status, status)
    assert.equal(f.item.channels.dns.dnsError, dnsError)
    assert.equal(JSON.parse(f.item.channels.dns.message).stage, stage)
  }
})

test('remote error on a corrected rejected product is not hidden by resubmission notice', () => {
  const f = fixture()
  f.item.channels.dns.dnsNeedsResubmission = true
  f.handler.processProductStatus(f.item, { ...remoteProduct('Rejected'), errorKind: 'CertificateExpired' }, f.channel, f.context)
  assert.equal(f.item.channels.dns.status, 3)
  assert.equal(f.item.channels.dns.dnsError, true)
  assert.equal(f.item.channels.dns.dnsNeedsResubmission, false)
  assert.equal(JSON.parse(f.item.channels.dns.message).errorKind, 'CertificateExpired')
})

test('resubmission flag persists even when status and message are unchanged', async t => {
  const { Item } = require('../src/models/items.ts')
  const models = require('../src/models/index.ts')
  const Context = require('../src/context.ts').default
  const f = fixture()
  let saved = false
  const reloaded = {
    channels: { dns: { status: 4, message: 'saved', dnsNeedsResubmission: false } },
    changed() {}, async save() { saved = true }
  }
  Object.assign(f.item.channels.dns, { status: 4, message: 'saved', dnsNeedsResubmission: true, dnsError: false })
  t.mock.method(Item, 'findByPk', async () => reloaded)
  t.mock.method(Context, 'createAs', () => ({}))
  const previous = models.sequelize
  models.sequelize = { transaction: async callback => callback({}) }
  t.after(() => { models.sequelize = previous })
  await f.handler.saveItemIfChanged(f.channel, f.item)
  assert.equal(saved, true)
  assert.equal(reloaded.channels.dns.dnsNeedsResubmission, true)
  assert.equal(reloaded.channels.dns.dnsError, false)
})
