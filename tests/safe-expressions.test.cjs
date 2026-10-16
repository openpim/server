const { test } = require('node:test')
const assert = require('node:assert/strict')
const runtimePath = '../src/channels/expressions.ts'
function runtime() { return require(runtimePath) }

test('safe expressions preserve common mapping results, await and local IIFE variables', async () => {
  const { evaluateMappingExpression } = runtime()
  const env = { item: { values: { title: ' Blue ', list: [1, 2, 3] } }, data: null }
  assert.equal(await evaluateMappingExpression('item.values.title.trim().toUpperCase()', env), 'BLUE')
  assert.deepEqual(await evaluateMappingExpression('item.values.list.map(x => x * 2)', env), [2, 4, 6])
  assert.equal(await evaluateMappingExpression('(async () => { const x = await utils.lookup("a"); return x.value + 1 })()', env, { lookup: async id => ({ value: id === 'a' ? 2 : 0 }) }), 3)
  for (const [expr, expected] of [['null', null], ['undefined', undefined], ['[0,false,""]', [0, false, '']], ['({x:1})', { x: 1 }], ['item.values.missing ?? "default"', 'default']]) {
    assert.deepEqual(await evaluateMappingExpression(expr, env), expected)
  }
})

test('safe expressions reject globals, prototype access, mutation, regex and arbitrary function values', async () => {
  const { evaluateMappingExpression } = runtime()
  for (const expr of ['process.env', 'globalThis', '({}).constructor', 'item["con"+"structor"]', 'item.values.x = 1', 'new Function("return 1")()', '/(a+)+$/.test("aaa")', 'item.values.fn()']) {
    await assert.rejects(evaluateMappingExpression(expr, { item: { values: { fn: () => 1 } } }), /not allowed|forbidden|unsupported|Unknown|JSON/i)
  }
})

test('safe expressions bound computation and asynchronous capabilities', async () => {
  const { evaluateMappingExpression } = runtime()
  await assert.rejects(evaluateMappingExpression('(() => { while (true) {} })()', {}, {}, { maxSteps: 100 }), /limit|unsupported/i)
  await assert.rejects(evaluateMappingExpression('await utils.hang()', {}, { hang: () => new Promise(() => {}) }, { timeoutMs: 20 }), /timeout/i)
})

test('expression validation rejects invalid syntax and unsupported programs without running capabilities', () => {
  const { validateMappingExpression } = runtime()
  assert.equal(validateMappingExpression('await utils.lookup("a")').valid, true)
  assert.equal(validateMappingExpression('const x = 1; return x').valid, false)
  assert.equal(validateMappingExpression('<div/>').valid, false)
  assert.equal(validateMappingExpression('process.env').valid, false)
  assert.equal(validateMappingExpression('item.values.color ?? ""').valid, true)
  const multiline = validateMappingExpression('item.values.x +\n process.env.x')
  assert.equal(multiline.line, 2)
  assert.equal(multiline.column, 2)
})

test('native coercion cannot expand aliased nested arrays outside the computation budget', async () => {
  const { evaluateMappingExpression } = runtime()
  const expressions = ['item.values.list.join()', 'String(item.values.list)', '`value=${item.values.list}`', '"" + item.values.list', 'parseInt(item.values.list)', 'parseFloat(item.values.list)', 'isNaN(item.values.list)', 'JSON.parse(item.values.list)', 'parseInt("1", item.values.list)', '(1).toFixed(item.values.list)']
  const leaf = ['long', 'long']
  const nested = [leaf, leaf]
  for (const expression of expressions) await assert.rejects(evaluateMappingExpression(expression, { item: { values: { list: nested } } }), /coercion|primitive/i)
  await assert.rejects(evaluateMappingExpression('item.values.list.map(x => x + 1)', { item: { values: { list: Array(100).fill(1) } } }, {}, { maxSteps: 30 }), /computation limit/i)
})

test('optional chains, lexical blocks and spread calls preserve expression semantics', async () => {
  const { evaluateMappingExpression, validateMappingExpression } = runtime()
  assert.equal(await evaluateMappingExpression('item?.values.title', { item: null }), undefined)
  assert.equal(await evaluateMappingExpression('item.values.missing?.()', { item: { values: {} } }), undefined)
  assert.equal(await evaluateMappingExpression('(() => { const x=1; if(true){const x=2;} return x })()', {}), 1)
  assert.equal(await evaluateMappingExpression('String(...[123])', {}), '123')
  for (const expression of ['1 << 2', 'delete item.x', '(() => { var x=1; return x })()']) assert.equal(validateMappingExpression(expression).valid, false)
})

test('aggregate output is limited before JSON serialization and optional computed keys short-circuit', async () => {
  const { evaluateMappingExpression } = runtime()
  const input = { item: { values: { text: 'x'.repeat(100000), list: Array(100).fill(0) } } }
  for (const source of ['item.values.list.map(x => item.values.text)', 'JSON.stringify(item.values.list.map(x => item.values.text))']) await assert.rejects(evaluateMappingExpression(source, input), /size limit/)
  let calls = 0
  assert.equal(await evaluateMappingExpression('item?.[utils.lookup()]', { item: null }, { lookup: () => { calls++; return 'x' } }), undefined)
  assert.equal(calls, 0)
  assert.equal(await evaluateMappingExpression('item.values.list === null', input), false)
  assert.equal(await evaluateMappingExpression('item.values.list != null', input), true)
})
