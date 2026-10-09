import { MappingAIConfig, requestMappingBatch } from './provider'
import type { DictionarySample } from './values'

export type { MappingAIConfig } from './provider'

export interface MappingCandidate {
    attrIdent: string
    name: string
    group: string
    type: number
    dictionary: boolean
    typeName?: string
    numeric?: boolean
    valueOptions?: DictionarySample
}

export interface MappingRequest {
    attribute: { id: string; name: string; description: string; required: boolean; dictionary: boolean; numeric: boolean; typeName?: string; unit?: string; valueOptions?: DictionarySample }
    candidates: MappingCandidate[]
}

export interface MappingSuggestion {
    id: string
    attrIdent: string | null
    needsReview: boolean
    reason: string
    alternatives?: { attrIdent: string; reason: string; needsReview: boolean }[]
}

export interface MappingVisibilityContext {
    paths: string[]
    targetPaths?: string[]
    relationId: number | null
}

export function createMappingVisibilityFilter(context?: MappingVisibilityContext): (attr: any) => boolean {
    const ancestors = new Set(context?.paths.flatMap(path => path.split('.').map(id => String(Number(id)))) || [])
    const targetAncestors = new Set(context?.targetPaths?.flatMap(path => path.split('.').map(id => String(Number(id)))) || [])
    return (attr: any): boolean => {
        // No reliable category context: do not guess item visibility from marketplace IDs.
        if (!context || !context.paths.length) return true
        if (Array.isArray(attr.visible) && attr.visible.length === 0) return false
        if (!Array.isArray(attr.visible)) return true
        const relations = Array.isArray(attr.relations) ? [...new Set<string>(attr.relations.map(String))] : []
        const standard = Array.isArray(attr.options) && attr.options.some((option: any) => option.name === 'standard_attribute' && option.value === 'true')
        if (context.relationId !== null) {
            // Standard, relation-valued and ordinary fields follow the product's path.
            // Relation-backed fields follow source paths; unrelated domains stay unknown.
            if (standard || Number(attr.type) === 9 || relations.length === 0) {
                if (!targetAncestors.size) return true
                return attr.visible.some((id: any) => targetAncestors.has(String(Number(id))))
            }
            if (relations.length !== 1 || relations[0] !== String(context.relationId)) return true
        } else if (!standard && Number(attr.type) !== 9 && relations.length > 0) return true
        return attr.visible.some((id: any) => ancestors.has(String(Number(id))))
    }
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum: number): number {
    const raw = env[key]
    const value = raw === undefined || raw === '' ? fallback : Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid ' + key + ' (1–' + maximum + ').')
    return value
}

export function readMappingConfig(env: NodeJS.ProcessEnv = process.env): MappingAIConfig {
    const disabled: MappingAIConfig = { enabled: false, provider: '', baseUrl: '', apiKey: '', model: '', timeoutMs: 60000, batchSize: 20, responseFormat: 'json_schema', useSystemCA: false }
    if (env.OPENPIM_AI_MAPPING_ENABLED !== 'true') return disabled
    const provider = env.OPENPIM_AI_PROVIDER || 'openai'
    if (!['openai', 'openai-compatible'].includes(provider)) throw new Error('Invalid AI mapping provider.')
    const baseUrl = (env.OPENPIM_AI_BASE_URL || (provider === 'openai' ? 'https://api.openai.com/v1' : '')).replace(/\/+$/, '')
    let url: URL
    try { url = new URL(baseUrl) } catch { throw new Error('Invalid OPENPIM_AI_BASE_URL.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid OPENPIM_AI_BASE_URL.')
    const apiKey = env.OPENPIM_AI_API_KEY?.trim() || ''
    if (provider === 'openai' && !apiKey) throw new Error('OPENPIM_AI_API_KEY is required.')
    const model = env.OPENPIM_AI_MODEL?.trim() || ''
    if (!model) throw new Error('OPENPIM_AI_MODEL is required.')
    const responseFormat = env.OPENPIM_AI_RESPONSE_FORMAT || 'json_schema'
    if (responseFormat !== 'json_schema' && responseFormat !== 'json_object') throw new Error('Invalid OPENPIM_AI_RESPONSE_FORMAT.')
    return {
        enabled: true, provider, baseUrl, apiKey, model, responseFormat,
        useSystemCA: env.OPENPIM_AI_USE_SYSTEM_CA === 'true',
        timeoutMs: positiveInteger(env, 'OPENPIM_AI_TIMEOUT_MS', 60000, 300000),
        batchSize: positiveInteger(env, 'OPENPIM_AI_MAPPING_BATCH_SIZE', 20, 30)
    }
}

function localizedName(name: any, language: string): string {
    if (typeof name === 'string') return name.slice(0, 400)
    if (!name || typeof name !== 'object') return ''
    return String(name[language] || Object.values(name).find(value => typeof value === 'string' && value) || '').slice(0, 400)
}

const ignoredTokens = new Set(['для', 'при', 'или', 'the', 'and', 'for', 'number', 'numeric', 'integer', 'decimal', 'text', 'boolean'])
// Deliberately bounded normalisation: do not stem arbitrary words or merge units.
const tokenAliases: Record<string, string> = {
    цвета: 'цвет', цветов: 'цвет', цвету: 'цвет', цветом: 'цвет', цветовой: 'цвет', цветовые: 'цвет', color: 'цвет', colour: 'цвет',
    ширины: 'ширина', ширину: 'ширина', width: 'ширина', высоты: 'высота', высоту: 'высота', height: 'высота',
    глубины: 'глубина', глубину: 'глубина', depth: 'глубина', длины: 'длина', length: 'длина',
    веса: 'вес', weight: 'вес', материала: 'материал', материалы: 'материал', material: 'материал',
    сантиметров: 'см', сантиметры: 'см', сантиметрах: 'см', cm: 'см',
    миллиметров: 'мм', миллиметры: 'мм', миллиметрах: 'мм', mm: 'мм',
    килограммов: 'кг', килограммы: 'кг', килограммах: 'кг', kg: 'кг'
}
function tokens(value: string): string[] {
    return [...new Set(value.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u)
        .filter(token => token.length > 1 && !ignoredTokens.has(token)).map(token => tokenAliases[token] || token))]
}

export function buildMappingRequests(groups: any[], attributes: any[], language: string, validTypes: any[], visibility?: MappingVisibilityContext): MappingRequest[] {
    const candidates = new Map<string, MappingCandidate>()
    const isVisible = createMappingVisibilityFilter(visibility)
    for (const group of groups) {
        if (!group.visible) continue
        for (const attr of group.attributes || []) {
            if (!attr.identifier || !Array.isArray(attr.valid) || attr.valid.length === 0) continue
            if (validTypes.length > 0 && !attr.valid.some((type: any) => validTypes.map(String).includes(String(type)))) continue
            if (!isVisible(attr)) continue
            const attrIdent = String(attr.identifier) + (attr.languageDependent ? '#' + language : '')
            const groupName = localizedName(group.name, language)
            const found = candidates.get(attrIdent)
            if (found) { found.group = (found.group + ', ' + groupName).slice(0, 800); continue }
            candidates.set(attrIdent, {
                attrIdent, name: localizedName(attr.name, language), group: groupName,
                type: Number(attr.type), dictionary: Number(attr.type) === 7
            })
        }
    }
    return attributes.map(attr => {
        // Only explicitly selected descriptive fields leave the server. In particular,
        // dictionaryLinkPost.headers contains marketplace keys and must never be copied.
        const attribute = {
            id: String(attr.id), name: String(attr.name || '').slice(0, 400),
            description: String(attr.description || '').slice(0, 1500),
            required: !!attr.required, dictionary: !!attr.dictionary,
            typeName: ({ ENUM: 'dictionary', TEXT: 'text', NUMERIC: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', OBJECT: 'object', TEXT_ARRAY: 'textArray', OBJECT_ARRAY: 'objectArray' } as Record<string, string>)[String(attr.type).toUpperCase()],
            numeric: !!attr.isNumber || ['NUMERIC', 'INTEGER'].includes(attr.type) || /\[(число|number)\]|\((integer|decimal|number)\)/i.test(attr.name || '')
        }
        const keywords = tokens(attribute.name)
        const ranked = [...candidates.values()].map(candidate => {
            const candidateWords = tokens(candidate.name + ' ' + candidate.attrIdent)
            const common = keywords.filter(word => candidateWords.includes(word)).length
            const exact = candidate.name.toLowerCase() === attribute.name.toLowerCase() ? 100 : 0
            const groupCommon = keywords.filter(word => tokens(candidate.group).includes(word)).length
            const dictionaryScore = attribute.dictionary && candidate.dictionary ? 1 : 0
            const numericScore = attribute.numeric && [3, 4].includes(candidate.type) ? 2 : 0
            return { candidate, score: exact + common * 10 + groupCommon + dictionaryScore + numericScore }
        }).sort((a, b) => b.score - a.score || a.candidate.attrIdent.localeCompare(b.candidate.attrIdent))
        return { attribute, candidates: ranked.slice(0, 30).map(row => row.candidate) }
    })
}

export function validateMappingResponse(response: any, requests: MappingRequest[], language = 'ru'): MappingSuggestion[] {
    if (!response || !Array.isArray(response.suggestions) || response.suggestions.length > requests.length) throw new Error('Invalid AI mapping response.')
    const seen = new Map<string, MappingSuggestion>()
    for (const entry of response.suggestions) {
        if (!entry || typeof entry.id !== 'string' || (entry.attrIdent !== null && typeof entry.attrIdent !== 'string') || typeof entry.needsReview !== 'boolean' || typeof entry.reason !== 'string') throw new Error('Invalid AI mapping suggestion.')
        const request = requests.find(row => row.attribute.id === entry.id)
        if (!request) throw new Error('Invalid marketplace identifier in AI mapping response.')
        if (seen.has(entry.id)) throw new Error('Duplicate marketplace identifier in AI mapping response.')
        if (entry.alternatives !== undefined && (!Array.isArray(entry.alternatives) || entry.alternatives.length > 3 || entry.alternatives.some((row: any) => !row || typeof row.attrIdent !== 'string' || typeof row.reason !== 'string'))) throw new Error('Invalid AI mapping alternatives.')
        const candidate = request.candidates.find(row => row.attrIdent === entry.attrIdent)
        if (entry.attrIdent !== null && !candidate) {
            seen.set(entry.id, {
                id: entry.id, attrIdent: null, needsReview: true,
                reason: language === 'ru'
                    ? 'Модель предложила атрибут вне списка допустимых кандидатов. Выберите соответствие вручную.'
                    : 'The model proposed an attribute outside the allowed candidates. Select a match manually.'
            })
            continue
        }
        const alternativeIds = new Set([entry.attrIdent])
        const alternatives = (entry.alternatives || []).filter((row: any) => {
            if (alternativeIds.has(row.attrIdent) || !request.candidates.some(candidate => candidate.attrIdent === row.attrIdent)) return false
            alternativeIds.add(row.attrIdent)
            return true
        }).map((row: any) => ({ attrIdent: row.attrIdent, reason: row.reason.slice(0, 600), needsReview: true }))
        const needsReview = entry.needsReview || alternatives.length > 0 || request.attribute.dictionary || request.attribute.numeric || !!candidate?.dictionary || [3, 4, 9].includes(candidate?.type || 0)
        seen.set(entry.id, { id: entry.id, attrIdent: entry.attrIdent, needsReview, reason: entry.reason.slice(0, 600), ...(alternatives.length ? { alternatives } : {}) })
    }
    return requests.map(row => seen.get(row.attribute.id) || { id: row.attribute.id, attrIdent: null, needsReview: true, reason: 'No unambiguous match found.' })
}

export async function suggestMappings(requests: MappingRequest[], config: MappingAIConfig, context: { category?: string; language?: string; marketplace?: string } = {}): Promise<MappingSuggestion[]> {
    if (!config.enabled) throw new Error('AI mapping is disabled.')
    if (requests.length > 200) throw new Error('AI mapping supports at most 200 attributes per request.')
    const deadline = Date.now() + config.timeoutMs
    const suggestions: MappingSuggestion[] = []
    const pending = requests.filter(row => row.candidates.length > 0)
    for (let index = 0; index < pending.length;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('AI mapping timeout.')
        const batch = pending.slice(index, index + config.batchSize)
        // Dictionary samples add context. Keep configured batchSize as an upper bound,
        // shrinking whole batches rather than silently dropping semantic metadata.
        while (batch.length > 1 && JSON.stringify({ ...context, attributes: batch }).length > 190000) batch.pop()
        const result = await requestMappingBatch({ ...context, attributes: batch }, config, remaining)
        suggestions.push(...validateMappingResponse(result, batch, context.language))
        if (Date.now() > deadline) throw new Error('AI mapping timeout.')
        index += batch.length
    }
    return requests.map(row => suggestions.find(suggestion => suggestion.id === row.attribute.id) || {
        id: row.attribute.id, attrIdent: null, needsReview: true, reason: 'No compatible PIM candidates found.'
    })
}
