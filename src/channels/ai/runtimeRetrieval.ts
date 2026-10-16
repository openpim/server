import { createHash } from 'crypto'
import type { MappingCandidate, MappingRequest } from './mapping'
import { normalizeVector, rankHybridCandidates } from './retrieval'
import { LocalEmbeddingClient, readLocalEmbeddingConfig } from './localEmbeddings'
import type { DictionarySample } from './values'

type Profile = { name: string; description?: string; group?: string; type?: number; typeName?: string; unit?: string; valueOptions?: DictionarySample }
export interface RetrievalContext { tenantId: string; channelId: string; language: string; category?: string }
export interface RetrievalDiagnostics { mode: 'lexical' | 'hybrid'; fallback?: 'embedding_unavailable' | 'pool_limit'; candidates: number; elapsedMs: number }
export interface RetrievalResult { requests: MappingRequest[]; diagnostics: RetrievalDiagnostics }
type Embeddings = Pick<LocalEmbeddingClient, 'embed'>

// Single bounded process cache; periodically recreate the client to recheck model digest.
let shared: { key: string; expires: number; client: LocalEmbeddingClient } | undefined
function embeddingClient(): LocalEmbeddingClient {
    const config = readLocalEmbeddingConfig()
    const key = JSON.stringify(config)
    if (!shared || shared.key !== key || shared.expires <= Date.now()) {
        shared = { key, expires: Date.now() + 5 * 60000, client: new LocalEmbeddingClient(config) }
    }
    return shared.client
}

export function meaningProfile(row: Profile): string {
    // Explicit descriptive allowlist. Never stringify the source metadata object.
    return [row.name, row.description, row.group, row.typeName || row.type, row.unit]
        .filter(value => typeof value === 'number' || typeof value === 'string' && value.trim())
        .map(value => String(value).slice(0, 1500)).join('\n').slice(0, 6000) || 'unknown attribute'
}

export function valueProfile(row: Profile): string {
    const sample = row.valueOptions
    if (sample?.status !== 'loaded' || (sample.sharedByAttributes || 0) > 1 && !sample.attributeFiltered) return ''
    const generic = /^(да|нет|yes|no|true|false|0|1|не указано|не применимо|нет данных|unknown|n\/a)$/iu
    const examples = [...new Set(sample.examples.filter(value => typeof value === 'string').map(value => value.trim().slice(0, 80))
        .filter(value => value && !generic.test(value)))].sort().slice(0, 8)
    return examples.length ? 'Value domain:\n' + examples.join('\n') : ''
}

export function rankProfileCandidates(attribute: Profile, candidates: MappingCandidate[], vectors: Map<string, number[]>): MappingCandidate[] {
    const dimensions = vectors.get(meaningProfile(attribute))?.length
    return rankNormalizedCandidates(attribute, candidates, new Map([...vectors].map(([text, vector]) => [text, normalizeVector(vector, dimensions)])))
}

function rankNormalizedCandidates(attribute: Profile, candidates: MappingCandidate[], vectors: Map<string, number[]>): MappingCandidate[] {
    const query = vectors.get(meaningProfile(attribute))!
    const queryValues = valueProfile(attribute)
    const queryDomain = queryValues ? vectors.get(queryValues)! : null
    const cosine = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index], 0)
    return candidates.map(candidate => {
        const meaning = vectors.get(meaningProfile(candidate))!
        const values = valueProfile(candidate)
        const domain = queryDomain && values ? vectors.get(values)! : null
        // Missing domain information is neutral, never evidence of incompatibility.
        const score = .85 * cosine(query, meaning) + (domain && queryDomain ? .15 * cosine(queryDomain, domain) : 0)
        return { candidate, score }
    }).sort((a, b) => b.score - a.score || a.candidate.attrIdent.localeCompare(b.candidate.attrIdent)).map(row => row.candidate)
}

export async function retrieveMappingCandidates(requests: MappingRequest[], context: RetrievalContext, mode: 'lexical' | 'hybrid' = 'lexical', client?: Embeddings): Promise<RetrievalResult> {
    const started = Date.now()
    const pool = new Map(requests.flatMap(request => request.candidates).map(row => [row.attrIdent, row]))
    const lexical = (fallback?: RetrievalDiagnostics['fallback']): RetrievalResult => ({
        requests: requests.map(request => ({ ...request, candidates: request.candidates.slice(0, 30) })),
        diagnostics: { mode: 'lexical', ...(fallback ? { fallback } : {}), candidates: pool.size, elapsedMs: Date.now() - started }
    })
    if (mode === 'lexical' || !pool.size) return lexical()
    if (pool.size > 2000) return lexical('pool_limit')
    try {
        const deadline = started + 60000
        const checkDeadline = () => { if (Date.now() >= deadline) throw new Error('Retrieval deadline exceeded.') }
        const queryProfile = (request: MappingRequest): Profile => ({ ...request.attribute, group: context.category })
        const profiles = [...pool.values(), ...requests.map(queryProfile)]
        const texts = [...new Set(profiles.flatMap(row => [meaningProfile(row), valueProfile(row)]).filter(Boolean))]
        const scope = createHash('sha256').update(JSON.stringify([context.tenantId, context.channelId])).digest('hex')
        // One deadline covers discovery and every embedding batch, including body reads.
        const vectors = await (client || embeddingClient()).embed(texts, scope, context.language, deadline)
        checkDeadline()
        if (vectors.length !== texts.length) throw new Error('Embedding count mismatch.')
        const dimensions = vectors[0]?.length
        const indexed = new Map(texts.map((text, index) => [text, normalizeVector(vectors[index], dimensions)]))
        const ranked: MappingRequest[] = []
        for (const request of requests) {
            // Warm caches must not turn a large mapping batch into an event-loop stall.
            await new Promise<void>(resolve => setImmediate(resolve))
            checkDeadline()
            ranked.push({ ...request, candidates: rankHybridCandidates(request.attribute, request.candidates,
                rankNormalizedCandidates(queryProfile(request), request.candidates, indexed)) })
        }
        checkDeadline()
        return { requests: ranked, diagnostics: { mode: 'hybrid', candidates: pool.size, elapsedMs: Date.now() - started } }
    } catch {
        // A remote body or thrown provider message may contain secrets. Return only a fixed code.
        return lexical('embedding_unavailable')
    }
}
