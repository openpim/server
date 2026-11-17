import { ChatConfig } from './config'
import { sanitizeForLog } from '../structuredLogger'

// Keep usage counters (not credentials) that the general log sanitizer treats as tokens.
const usageKeys = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
    'cached_tokens', 'reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens',
    'prompt_tokens_details', 'completion_tokens_details', 'input_tokens_details', 'output_tokens_details'])

export function sanitizeResponseDetails(value: any, config: ChatConfig): any {
    const clean = (item: any, usage = false, depth = 0): any => {
        if (depth > 60) return '[DEPTH_LIMIT]'
        if (typeof item === 'string') {
            let text = item
            for (const secret of [config.provider.apiKey, config.mcp.bearerToken]) {
                if (secret) text = text.split(secret).join('[REDACTED]')
            }
            return sanitizeForLog(text)
        }
        if (Array.isArray(item)) return item.map(child => clean(child, usage, depth + 1))
        if (!item || typeof item !== 'object') return item
        return Object.fromEntries(Object.entries(item).map(([key, child]) => {
            const metric = usage && usageKeys.has(key) && (typeof child === 'number' || (child && typeof child === 'object'))
            const sensitive = (sanitizeForLog({ [key]: null }) as any)[key] !== null
            return [key, sensitive && !metric ? '[REDACTED]' : clean(child, usage || key === 'usage', depth + 1)]
        }))
    }
    return clean(value)
}

export function providerResponseDetail(body: any, status: number, config: ChatConfig): any {
    // Redact before truncation: a cutoff must never expose part of a credential.
    const sanitized = sanitizeResponseDetails(body, config)
    const raw = JSON.stringify(sanitized)
    const limit = config.limits.maxResponseBytes
    return { kind: 'provider', status, truncated: raw.length > limit,
        response: raw.length > limit ? { notice: 'Response details exceeded the size limit.', preview: raw.slice(0, limit) } : sanitized }
}
