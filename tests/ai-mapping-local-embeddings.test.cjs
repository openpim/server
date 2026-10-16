const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const moduleUnderTest = () => require('../src/channels/ai/localEmbeddings.ts')

test('local config refuses remote URLs, URL credentials and cloud models', () => {
  const { readLocalEmbeddingConfig } = moduleUnderTest()
  for (const baseUrl of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://u:p@localhost:11434', 'http://localhost:11434/path']) assert.throws(() => readLocalEmbeddingConfig({ OPENPIM_AI_EMBEDDING_BASE_URL: baseUrl }), /loopback|URL/)
  assert.throws(() => readLocalEmbeddingConfig({ OPENPIM_AI_EMBEDDING_MODEL: 'kimi:cloud' }), /local|cloud/)
})

test('actual local API client caches vectors per scope/language/text/model digest and validates output', async t => {
  const { LocalEmbeddingClient, readLocalEmbeddingConfig } = moduleUnderTest()
  let digest = 'a'.repeat(64), embedded = 0, malformed = false, large = false
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'bge-m3:latest', digest }] }))
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['embedding'] }))
    let source = ''; for await (const chunk of req) source += chunk
    const payload = JSON.parse(source)
    assert.equal(payload.truncate, false)
    assert.equal(req.headers.authorization, undefined)
    embedded += payload.input.length
    res.end(JSON.stringify({ model: 'bge-m3:latest', embeddings: payload.input.map(() => malformed ? [0, 0] : large ? Array(1024).fill(.1234567890123456) : [1, 2]), prompt_eval_count: payload.input.length }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const config = readLocalEmbeddingConfig({ OPENPIM_AI_EMBEDDING_BASE_URL: 'http://127.0.0.1:' + server.address().port })
  const client = new LocalEmbeddingClient(config)
  assert.deepEqual(await client.embed(['Title', 'Title'], 'tenant-a', 'ru'), [[1, 2], [1, 2]])
  assert.equal(embedded, 1)
  await client.embed(['Title'], 'tenant-a', 'ru')
  assert.equal(embedded, 1)
  await client.embed(['Title changed'], 'tenant-a', 'ru')
  await client.embed(['Title'], 'tenant-b', 'ru')
  await client.embed(['Title'], 'tenant-a', 'en')
  assert.equal(embedded, 4)
  digest = 'b'.repeat(64)
  const updated = new LocalEmbeddingClient(config, client.exportCache())
  await updated.embed(['Title'], 'tenant-a', 'ru')
  assert.equal(embedded, 5)
  malformed = true
  await assert.rejects(updated.embed(['Bad'], 'tenant-a', 'ru'), /vector/)
  malformed = false; large = true
  const largerThanCache = new LocalEmbeddingClient(config)
  const vectors = await largerThanCache.embed(Array.from({ length: 1800 }, (_, i) => 'Text ' + i), 't', 'ru')
  assert.equal(vectors.length, 1800)
  assert.equal(vectors[0].length, 1024)
  assert.ok(largerThanCache.exportCache().entries.length < 1800)
})

test('remote Ollama-backed models are rejected before sending attribute text', async t => {
  const { LocalEmbeddingClient, readLocalEmbeddingConfig } = moduleUnderTest()
  let embeds = 0
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'bge-m3:latest', digest: 'a'.repeat(64) }] }))
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['embedding'], remote_host: 'https://ollama.com' }))
    embeds++; res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const client = new LocalEmbeddingClient(readLocalEmbeddingConfig({ OPENPIM_AI_EMBEDDING_BASE_URL: 'http://127.0.0.1:' + server.address().port }))
  await assert.rejects(client.embed(['private metadata'], 't', 'ru'), /remote|local/)
  assert.equal(embeds, 0)
})

test('a partial embedding response body is covered by the same request deadline', async t => {
  const { LocalEmbeddingClient, readLocalEmbeddingConfig } = moduleUnderTest()
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'bge-m3:latest', digest: 'a'.repeat(64) }] }))
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['embedding'] }))
    res.write('{"model":"bge-m3:latest",')
    setTimeout(() => res.end('"embeddings":[[1,2]]}'), 200)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const client = new LocalEmbeddingClient(readLocalEmbeddingConfig({ OPENPIM_AI_EMBEDDING_BASE_URL: 'http://127.0.0.1:' + server.address().port, OPENPIM_AI_EMBEDDING_TIMEOUT_MS: '50' }))
  await assert.rejects(client.embed(['Text'], 't', 'ru'), /timeout/)
})

test('a large valid cache is pruned to a compact file that the runner can reload', () => {
  const { LocalEmbeddingClient, readLocalEmbeddingConfig } = moduleUnderTest()
  const entries = Array.from({ length: 2000 }, (_, index) => [index.toString(16).padStart(64, '0'), Array(1024).fill(.1234567890123456)])
  const client = new LocalEmbeddingClient(readLocalEmbeddingConfig({}), { version: 1, entries })
  const cache = client.exportCache()
  assert.ok(cache.entries.length < entries.length)
  assert.ok(Buffer.byteLength(JSON.stringify(cache)) < 32 * 1024 * 1024)
  assert.equal(cache.entries.at(-1)[0], entries.at(-1)[0])
  assert.doesNotThrow(() => new LocalEmbeddingClient(readLocalEmbeddingConfig({}), JSON.parse(JSON.stringify(cache))))
})
