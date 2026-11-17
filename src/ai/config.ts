export interface ChatIdentity { id: number; tenantId: string }
export interface ChatConfig {
    tenantId: string
    provider: { adapter: string; baseUrl: string; apiKey: string; model: string; maxTokensParameter?: 'max_tokens' | 'max_completion_tokens' }
    mcp: { url: string; bearerToken: string }
    limits: {
        requestTimeoutMs: number; maxToolRounds: number; maxToolCalls: number
        maxConcurrentRequests: number; maxConcurrentRequestsPerUser: number
        maxInputChars: number; maxHistoryChars: number; maxHistoryTurns: number
        maxToolResultChars: number; maxStoredToolResultChars: number; maxResponseBytes: number; maxOutputTokens: number
    }
}

const defaults: ChatConfig['limits'] = {
    requestTimeoutMs: 120000, maxToolRounds: 8, maxToolCalls: 20,
    maxConcurrentRequests: 5, maxConcurrentRequestsPerUser: 1,
    maxInputChars: 12000, maxHistoryChars: 48000, maxHistoryTurns: 20,
    maxToolResultChars: 16000, maxStoredToolResultChars: 64000, maxResponseBytes: 2000000, maxOutputTokens: 4096
}

export function hasChatAccess(server: any, user?: ChatIdentity | null, roles: { otherAccess?: { ai?: boolean } }[] = []): boolean {
    const config = server?.AI_ChatConfig
    return server?.AI_Chat === true && !!user && !!config
        && String(config.tenantId) === String(user.tenantId)
        && roles.some(role => role?.otherAccess?.ai === true)
}

export function readChatConfig(server: any): ChatConfig {
    const raw = server?.AI_ChatConfig
    if (!raw || raw.provider?.adapter !== 'openai-compatible') throw new Error('AI-чат: неподдерживаемый адаптер провайдера')
    for (const url of [raw.provider?.baseUrl, raw.mcp?.url]) {
        let parsed: URL
        try { parsed = new URL(url) } catch { throw new Error('AI-чат: неверный URL подключения') }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
            throw new Error('AI-чат: URL должен быть HTTP(S), без credentials, query и fragment')
        }
    }
    for (const value of [raw.provider?.apiKey, raw.provider?.model, raw.mcp?.bearerToken]) {
        if (typeof value !== 'string' || !value.trim()) throw new Error('AI-чат: не заполнены параметры подключения')
    }
    const maxTokensParameter = raw.provider.maxTokensParameter ?? 'max_tokens'
    if (!['max_tokens', 'max_completion_tokens'].includes(maxTokensParameter)) throw new Error('AI-чат: неверный параметр ограничения токенов')
    const limits = { ...defaults }
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
        const value = raw.limits?.[key] ?? defaults[key]
        if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key] * 20) throw new Error('AI-чат: неверные ограничения')
        limits[key] = value
    }
    // The product contract permits only one active request per user.
    limits.maxConcurrentRequestsPerUser = 1
    return { ...raw, provider: { ...raw.provider, maxTokensParameter }, limits }
}

export function publicServerConfig(server: any): any {
    const { storage, AI_ChatConfig, ...publicConfig } = server || {}
    return publicConfig
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function selectHistory(pairs: { input: string; output: string }[], maxTurns: number, maxChars: number) {
    const selected: typeof pairs = []
    let chars = 0
    for (const pair of [...pairs].reverse()) {
        if (selected.length >= maxTurns || chars + pair.input.length + pair.output.length > maxChars) break
        selected.unshift(pair)
        chars += pair.input.length + pair.output.length
    }
    return { pairs: selected, truncated: selected.length < pairs.length }
}
