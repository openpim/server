// Synthetic, local-only transport/cache smoke test. No .env, database, saved mappings or final LLM.
const { retrieveMappingCandidates } = require('../../src/channels/ai/runtimeRetrieval.ts')
const { LocalEmbeddingClient, readLocalEmbeddingConfig } = require('../../src/channels/ai/localEmbeddings.ts')
const values = examples => ({ status: 'loaded', examples, attributeFiltered: true, sharedByAttributes: 1 })

async function main() {
  const client = new LocalEmbeddingClient(readLocalEmbeddingConfig())
  const requests = [{
    attribute: { id: 'synthetic-material', name: 'Материал рабочей поверхности', description: 'Материал поверхности варочной панели', dictionary: true, valueOptions: values(['стеклокерамика', 'эмаль', 'нержавеющая сталь']) },
    candidates: [
      { attrIdent: 'surface', name: 'Покрытие панели', description: 'Материал рабочей поверхности', group: 'Варочные панели', type: 7, dictionary: true, valueOptions: values(['стеклокерамика', 'эмаль', 'нержавеющая сталь']) },
      { attrIdent: 'packaging', name: 'Материал упаковки', description: 'Материал транспортной коробки', group: 'Упаковка', type: 7, dictionary: true, valueOptions: values(['картон', 'пластик']) },
      { attrIdent: 'control', name: 'Управление', description: 'Способ управления панелью', group: 'Варочные панели', type: 7, dictionary: true, valueOptions: values(['сенсорное', 'механическое']) }
    ]
  }]
  const context = { tenantId: 'synthetic-smoke', channelId: 'synthetic', language: 'ru', category: 'Варочные панели' }
  const cold = await retrieveMappingCandidates(requests, context, 'hybrid', client)
  const coldStats = { ...client.stats }
  const warm = await retrieveMappingCandidates(requests, context, 'hybrid', client)
  console.log(JSON.stringify({ synthetic: true, cold: cold.diagnostics, warm: warm.diagnostics, coldStats, finalStats: client.stats,
    identifiers: warm.requests[0].candidates.map(row => row.attrIdent) }, null, 2))
  if (cold.diagnostics.mode !== 'hybrid' || warm.diagnostics.mode !== 'hybrid' || client.stats.requests !== coldStats.requests) process.exitCode = 1
}
main().catch(() => { console.error('Local runtime smoke failed.'); process.exitCode = 1 })
