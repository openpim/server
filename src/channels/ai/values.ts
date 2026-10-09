import fetch from 'node-fetch'
import type { MappingRequest } from './mapping'
import { createMappingHTTPSAgent, MappingAIConfig } from './provider'

export interface DictionarySample {
    status: 'loaded' | 'unavailable'
    examples: string[]
    total: number | null
    truncated: boolean
    sharedByAttributes?: number
}
export type LoadPIMDictionaries = (ids: number[], tenantId: string) => Promise<{ id: number; values: any[]; total?: number }[]>
const typeNames: Record<number, string> = { 1: 'text', 2: 'boolean', 3: 'integer', 4: 'float', 5: 'date', 6: 'time', 7: 'dictionary', 8: 'url', 9: 'relation' }
const unavailable = (): DictionarySample => ({ status: 'unavailable', examples: [], total: null, truncated: false })

export function sampleDictionary(data: any, language: string): DictionarySample {
    const values = Array.isArray(data?.values) ? data.values : Array.isArray(data?.result) ? data.result : null
    if (!values) return unavailable()
    const examples = new Set<string>()
    for (const row of values.slice(0, 256)) {
        const raw = typeof row === 'string' ? row : row?.value
        const localized = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw[language] || Object.values(raw).find(value => typeof value === 'string') : null
        if (typeof localized !== 'string' || !localized.trim()) continue
        examples.add(localized.trim().slice(0, 80))
        if (examples.size === 8) break
    }
    const explicitTotal = Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null
    const total = explicitTotal ?? (data.has_next ? null : values.length)
    return { status: 'loaded', examples: [...examples], total,
        truncated: !!data.has_next || total === null || total > examples.size || values.length > examples.size }
}

// All fields selected explicitly; URLs, IDs, request headers and product values never enter the model context.
export async function enrichMappingRequests(requests: MappingRequest[], groups: any[], attributes: any[], language: string, tenantId: string,
    loadPIM?: LoadPIMDictionaries, loadMarketplace?: (attribute: any) => Promise<any>): Promise<MappingRequest[]> {
    const originals = new Map<string, any>()
    for (const group of groups) for (const attr of group.attributes || []) {
        originals.set(String(attr.identifier) + (attr.languageDependent ? '#' + language : ''), attr)
    }
    const shared = new Map<number, number>()
    for (const original of originals.values()) {
        const id = Number(original.lov)
        if (Number.isSafeInteger(id) && id > 0) shared.set(id, (shared.get(id) || 0) + 1)
    }
    const ids = [...new Set(requests.flatMap(request => request.candidates.filter(candidate => candidate.dictionary).map(candidate => Number(originals.get(candidate.attrIdent)?.lov)))
        .filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 200)
    const dictionaries = new Map<number, DictionarySample>()
    if (ids.length && loadPIM) {
        try {
            for (const row of await loadPIM(ids, tenantId)) {
                if (ids.includes(Number(row.id))) dictionaries.set(Number(row.id), sampleDictionary(row, language))
            }
        } catch { /* unavailable metadata must not expose errors or imply an empty dictionary */ }
    }
    const market = new Map<string, DictionarySample>()
    let fetched = 0
    // Bounded first-page lookups. Yandex inline values do not need another request.
    for (const request of requests) {
        if (!request.attribute.dictionary || market.has(request.attribute.id)) continue
        const attr = attributes.find(row => String(row.id) === request.attribute.id)
        let sample = unavailable()
        if (Array.isArray(attr?.dictionaryValues)) sample = sampleDictionary({ values: attr.dictionaryValues }, language)
        else if (loadMarketplace && fetched < 20) {
            fetched++
            try { sample = sampleDictionary(await loadMarketplace(attr), language) } catch { /* keep unknown context */ }
        }
        market.set(request.attribute.id, sample)
    }
    return requests.map(request => {
        const original = attributes.find(row => String(row.id) === request.attribute.id)
        const attribute = { ...request.attribute }
        if (typeof original?.unit === 'string') attribute.unit = original.unit.slice(0, 80)
        if (attribute.dictionary) attribute.valueOptions = market.get(attribute.id) || unavailable()
        return { attribute, candidates: request.candidates.map(candidate => {
            const enriched = { ...candidate, typeName: typeNames[candidate.type] || 'unknown', numeric: [3, 4].includes(candidate.type) }
            if (candidate.dictionary) {
                const id = Number(originals.get(candidate.attrIdent)?.lov)
                enriched.valueOptions = { ...(dictionaries.get(id) || unavailable()), sharedByAttributes: shared.get(id) || 0 }
            }
            return enriched
        }) }
    })
}

export const mappingLOVSamplesSQL = `
SELECT id, jsonb_array_length("values") AS total,
    COALESCE((SELECT jsonb_agg(l."values" -> ord ORDER BY ord)
        FROM generate_series(0, LEAST(7,jsonb_array_length(l."values")-1)) ord), '[]'::jsonb) AS "values"
FROM lovs l WHERE "tenantId"=$1 AND "deletedAt" IS NULL AND id=ANY($2::integer[]) AND jsonb_typeof("values")='array'
`

export async function loadMarketplaceDictionary(attribute: any, config: MappingAIConfig, timeoutMs: number, request: typeof fetch = fetch): Promise<any> {
    const urls = ['https://api.partner.market.yandex.ru/v2/category/' + attribute?.category + '/parameters',
        'https://api-seller.ozon.ru/v2/category/attribute/values', 'https://api-seller.ozon.ru/v1/description-category/attribute/values']
    if (!attribute?.dictionaryLinkPost || !urls.includes(attribute.dictionaryLink) || timeoutMs <= 0) return {}
    const body: Record<string, unknown> = {}
    for (const key of ['attribute_id', 'category_id', 'description_category_id', 'type_id', 'language', 'last_value_id', 'limit']) {
        const value = attribute.dictionaryLinkPost.body?.[key]
        if (typeof value === 'string' || typeof value === 'number') body[key] = value
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    for (const [key, value] of Object.entries(attribute.dictionaryLinkPost.headers || {})) {
        if (['api-key', 'client-id'].includes(key.toLowerCase()) && typeof value === 'string') headers[key] = value
    }
    const agent = createMappingHTTPSAgent(config.useSystemCA)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(5000, timeoutMs))
    try {
        const response = await request(attribute.dictionaryLink, { method: 'POST', headers, body: JSON.stringify(body),
            redirect: 'error', timeout: Math.min(5000, timeoutMs), size: 512 * 1024, agent, signal: controller.signal })
        if (!response.ok) return {}
        const json = await response.json()
        if (Array.isArray(json.result?.parameters)) {
            const parameter = json.result.parameters.find((row: any) => 'yandexattr_' + row.id === String(attribute.id))
            return Array.isArray(parameter?.values) ? { values: parameter.values } : {}
        }
        return json
    } catch { return {} } finally { clearTimeout(timer); agent?.destroy() }
}
