const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateChannelExpressions } = require('../src/channels/expressionValidation.ts')

test('SAVE rejects edited unsafe source but preserves unchanged legacy expressions', () => {
  const old = { a: { categoryExpr: 'process.env', attributes: [{ id: 'x', expr: '/old/.test(item.values.x)' }] } }
  assert.doesNotThrow(() => validateChannelExpressions({}, old, {}, old))
  assert.throws(() => validateChannelExpressions({}, { a: { attributes: [{ id: 'x', expr: 'require("fs")' }] } }, {}, old), /a.x.*not allowed/)
  assert.throws(() => validateChannelExpressions({ variantExpr: 'new Function("return 1")' }, {}), /variantExpr/)
  assert.throws(() => validateChannelExpressions({ ymShopAttributes: [{ name: 'shop', expr: 'process' }] }, {}), /ymShopAttributes.shop/)
  assert.doesNotThrow(() => validateChannelExpressions({ variantExpr: 'item.values.color === "blue"' }, { a: { categoryExpr: 'String(item.typeId)', attributes: [{ id: 'x', expr: 'await utils.getItem("x")' }] } }))
})

test('shop legacy expressions are matched by field id when preserving unchanged configuration', () => {
  const config = { ymShopAttributes: [{ id: 'name', expr: '"shop"' }, { id: 'url', expr: 'process.env.URL' }] }
  assert.doesNotThrow(() => validateChannelExpressions(config, {}, config))
})
