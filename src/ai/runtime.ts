import fetch from 'node-fetch'
import { ChatConfig } from './config'
import logger from '../logger'
import { providerResponseDetail, sanitizeResponseDetails } from './responseDetails'
import { validateCatalogToolArguments } from './catalogToolPolicy'
import { CatalogPagination, catalogArgumentsKey } from './catalogPagination'
import { appendModelMessage, modelCatalogResult } from './modelContext'
import { catalogUsageInstructions, normalizeCatalogArguments } from './catalogArguments'

export interface AiProvider {
    complete(messages: any[], tools: any[], signal: AbortSignal): Promise<any>
}

export class OpenAICompatibleProvider implements AiProvider {
    constructor(private config: ChatConfig, private onResponse?: (detail: any) => void) {}
    async complete(messages: any[], tools: any[], signal: AbortSignal): Promise<any> {
        const response = await fetch(this.config.provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST', redirect: 'error', signal: signal as any,
            size: this.config.limits.maxResponseBytes,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.provider.apiKey}` },
            body: JSON.stringify({ model: this.config.provider.model, messages,
                ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
                [this.config.provider.maxTokensParameter || 'max_tokens']: this.config.limits.maxOutputTokens, stream: false })
        })
        let body: any
        let text: string
        try { text = await response.text() }
        catch {
            this.onResponse?.(providerResponseDetail({ notice: 'Response body could not be read (network or size limit).' }, response.status, this.config))
            logger.warn(`[AI-chat] provider returned unreadable response: HTTP ${response.status}, endpoint=chat/completions`)
            throw new Error('AI_PROVIDER_FAILED')
        }
        try { body = JSON.parse(text) }
        catch {
            this.onResponse?.(providerResponseDetail({ notice: 'Response body was not valid JSON.', body: text }, response.status, this.config))
            logger.warn(`[AI-chat] provider returned invalid JSON: HTTP ${response.status}, endpoint=chat/completions`)
            throw new Error('AI_PROVIDER_FAILED')
        }
        this.onResponse?.(providerResponseDetail(body, response.status, this.config))
        if (!response.ok) {
            // Do not log response bodies: provider errors can echo credentials or user input.
            logger.warn(`[AI-chat] provider request failed: HTTP ${response.status}, endpoint=chat/completions`)
            throw new Error('AI_PROVIDER_FAILED')
        }
        const choice = body?.choices?.[0]
        if (!choice?.message || choice.finish_reason === 'length') {
            const reason = choice?.finish_reason === 'length' ? 'output token limit reached' : 'missing choices[0].message'
            logger.warn(`[AI-chat] provider returned unusable response: ${reason}`)
            throw new Error('AI_PROVIDER_FAILED')
        }
        return choice.message
    }
}

// A fixed catalog allowlist is intentional: readOnlyHint alone is not an authorization boundary.
export const catalogToolNames = new Set([
    'catalog_list', 'catalog_get', 'category_search', 'category_get',
    'product_search', 'product_get', 'product_get_many',
    'variant_search', 'variant_get', 'variant_get_many'
])

export interface CatalogClient {
    instructions?: string
    listTools(): Promise<any[]>
    callTool(name: string, args: any): Promise<any>
    close(): Promise<void>
}

export async function connectCatalog(config: ChatConfig, signal: AbortSignal): Promise<CatalogClient> {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js')
    const outputValidators = new Map<string, (data: any) => { valid: boolean }>()
    const client = new Client({ name: 'openpim-ai-chat', version: '1.0.0' }, { capabilities: {} })
    const nativeFetch = (globalThis as any).fetch
    if (!nativeFetch) throw new Error('MCP_REQUIRES_NODE_18')
    const transport = new StreamableHTTPClientTransport(new URL(config.mcp.url), {
        requestInit: { headers: { authorization: `Bearer ${config.mcp.bearerToken}` } },
        fetch: async (url: any, options: any) => {
            // Requests never redirect a bearer credential to another endpoint.
            const response = await nativeFetch(url, { ...options, redirect: 'error', signal })
            if (!response.body) return response
            const reader = response.body.getReader()
            let bytes = 0
            const stream = new (globalThis as any).ReadableStream({
                async pull(controller: any) {
                    try {
                        const next = await reader.read()
                        if (next.done) { controller.close(); return }
                        bytes += next.value.byteLength
                        if (bytes > config.limits.maxResponseBytes) {
                            await reader.cancel()
                            controller.error(new Error('AI_MCP_FAILED'))
                            return
                        }
                        controller.enqueue(next.value)
                    } catch { controller.error(new Error('AI_MCP_FAILED')) }
                },
                cancel() { return reader.cancel() }
            })
            return new (globalThis as any).Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
        }
    })
    try { await client.connect(transport, { signal, timeout: config.limits.requestTimeoutMs }) }
    catch (error) { await client.close().catch(() => {}); throw new Error('AI_MCP_FAILED') }
    return {
        instructions: client.getInstructions(),
        async listTools() {
            outputValidators.clear()
            const all: any[] = []
            let cursor: string | undefined
            const seen = new Set<string>()
            do {
                const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: config.limits.requestTimeoutMs })
                all.push(...page.tools)
                // SDK caches only the latest page; keep validators across every tools/list page.
                for (const tool of page.tools) {
                    const validator = client.getToolOutputValidator(tool.name)
                    if (validator) outputValidators.set(tool.name, validator)
                }
                cursor = page.nextCursor
                if (cursor && (seen.has(cursor) || seen.size >= 10)) throw new Error('AI_MCP_FAILED')
                if (cursor) seen.add(cursor)
            } while (cursor)
            return all.filter(tool => catalogToolNames.has(tool.name) && tool.annotations?.readOnlyHint === true)
        },
        async callTool(name, args) {
            // SDK 1.x callTool incorrectly validates structured error payloads against
            // the success schema. Use the public protocol request and validate only success.
            const result = await client.request({ method: 'tools/call', params: { name, arguments: args } },
                CallToolResultSchema, { signal, timeout: config.limits.requestTimeoutMs })
            if (result.isError === true) return result
            const validate = outputValidators.get(name)
            if (validate && (!result.structuredContent || !validate(result.structuredContent).valid)) throw new Error('AI_MCP_FAILED')
            return result
        },
        async close() { await client.close() }
    }
}

export async function runConversation(options: {
    config: ChatConfig; provider: AiProvider; catalog: CatalogClient; messages: any[]
    signal: AbortSignal; check: () => Promise<void>; trace: any[]
    catalogHistory?: { name: string; arguments: any; result: any }[]
    onProgress?: (event?: any) => Promise<void>
}): Promise<string> {
    const { config, provider, catalog, messages, signal, check, trace, onProgress } = options
    await check()
    await onProgress?.({ stage: 'catalog_tools' })
    const listed = await catalog.listTools()
    const tools = listed.filter(tool => catalogToolNames.has(tool.name) && tool.annotations?.readOnlyHint === true)
    if (!tools.length) throw new Error('AI_MCP_FAILED')
    const allowed = new Set(tools.map(tool => tool.name))
    const schemas = new Map(tools.map(tool => [tool.name, tool.inputSchema]))
    const firstNonSystem = messages.findIndex(message => message.role !== 'system')
    messages.splice(firstNonSystem < 0 ? messages.length : firstNonSystem, 0, {
        role: 'system', content: catalogUsageInstructions + '\n'
            + (catalog.instructions || '').slice(0, Math.min(2000, Math.max(0, 3500 - catalogUsageInstructions.length)))
    })
    // Preserve MCP optional fields. Some compatible gateways make every optional
    // property effectively required when strict is omitted, provoking fabricated values.
    const definitions = tools.map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false
    } }))
    const exactCodeTool = 'product_get_by_code'
    const canLookupCode = allowed.has('product_search') && allowed.has('product_get')
    if (canLookupCode) {
        allowed.add(exactCodeTool)
        definitions.push({ type: 'function', function: {
            name: exactCodeTool, strict: false, description: 'Get a full product card by exact code in a known catalog. No other filters or cursor are needed.',
            parameters: { type: 'object', properties: { catalogId: { type: 'integer', minimum: 1 }, code: { type: 'string', minLength: 1 } },
                required: ['catalogId', 'code'], additionalProperties: false }
        } })
    }
    const pagination = new CatalogPagination(schemas)
    // Only the service's owner-scoped, parsed MCP trace can restore cursor provenance.
    // User/assistant prose and provider envelopes never issue cursors.
    for (const record of options.catalogHistory || []) {
        if (schemas.has(record.name)) pagination.observe(record.name, record.arguments, record.result)
    }
    const failures = new Map<string, any>()
    const contextLimit = config.limits.maxHistoryChars + config.limits.maxInputChars + 4000
    const append = async (message: any) => {
        if (appendModelMessage(messages, message, contextLimit)) await onProgress?.({ stage: 'assistant_message',
            contextTruncated: true, content: 'Освобождено место в контексте: старые обмены исключены, текущий результат сохранён.' })
    }
    let calls = 0
    let requests = 0
    const invoke = async (name: string, args: any): Promise<any> => {
        await check()
        const key = name + ':' + catalogArgumentsKey(args)
        if (failures.has(key)) return failures.get(key)
        if (calls >= config.limits.maxToolCalls) throw new Error('AI_LIMIT')
        calls++
        const entry = sanitizeResponseDetails({ kind: 'mcp', status: 'running', name, arguments: args,
            startedAt: new Date().toISOString() }, config)
        trace.push(entry)
        await onProgress?.()
        let result: any
        try { result = await catalog.callTool(name, args) }
        catch (error) {
            Object.assign(entry, { status: 'error', finishedAt: new Date().toISOString(), error: 'AI_MCP_FAILED' })
            await onProgress?.()
            throw error
        }
        pagination.observe(name, args, result)
        const raw = JSON.stringify(sanitizeResponseDetails(result, config))
        // Persist MCP data independently of the model's remaining history budget.
        const resultLimit = config.limits.maxStoredToolResultChars
        const truncated = raw.length > resultLimit
        const content = truncated ? JSON.stringify({ truncated: true,
            notice: 'Result too large. Narrow the query or reduce page size.', preview: raw.slice(0, resultLimit) }) : raw
        Object.assign(entry, { result: content, truncated, status: result.isError === true ? 'error' : 'completed',
            finishedAt: new Date().toISOString() })
        await onProgress?.()
        if (result.isError === true) failures.set(key, result)
        return result
    }
    for (let round = 0; round <= config.limits.maxToolRounds; round++) {
        await check()
        const finalOnly = round === config.limits.maxToolRounds || calls >= config.limits.maxToolCalls || requests >= config.limits.maxToolCalls
        if (finalOnly) await append({ role: 'system', content:
            'The tool budget is exhausted. Make no more tool calls. Answer from verified available data; explicitly state incomplete pagination or other limitations. Do not claim a complete listing when hasMore is true or any pages are missing. Earlier tool exchanges may have been omitted from context, not from saved MCP details.' })
        if (JSON.stringify(messages).length > contextLimit) throw new Error('AI_CONTEXT_LIMIT')
        await onProgress?.({ stage: 'provider_request', round: round + 1 })
        const answer = await provider.complete(messages, finalOnly ? [] : definitions, signal)
        const requested = answer.tool_calls || []
        if (!Array.isArray(requested)) throw new Error('AI_PROVIDER_FAILED')
        if (!requested.length) {
            if (typeof answer.content !== 'string' || !answer.content.trim() || answer.content.length > config.limits.maxResponseBytes) {
                throw new Error('AI_PROVIDER_FAILED')
            }
            return answer.content
        }
        if (typeof answer.content === 'string' && answer.content.trim()) {
            const text = sanitizeResponseDetails(answer.content, config)
            await onProgress?.({ stage: 'assistant_message', content: text.slice(0, config.limits.maxInputChars),
                truncated: text.length > config.limits.maxInputChars })
        }
        if (finalOnly || requests + requested.length > config.limits.maxToolCalls) throw new Error('AI_LIMIT')
        requests += requested.length
        // The transcript carries only the assistant message, never private reasoning or API metadata.
        messages.push({ role: 'assistant', content: answer.content || null, tool_calls: requested })
        for (const call of requested) {
            await check()
            if (!call.id || !allowed.has(call.function?.name) || typeof call.function.arguments !== 'string'
                || call.function.arguments.length > config.limits.maxInputChars) throw new Error('AI_INVALID_TOOL')
            let args: any
            try { args = JSON.parse(call.function.arguments) } catch { throw new Error('AI_INVALID_TOOL') }
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('AI_INVALID_TOOL')
            args = normalizeCatalogArguments(schemas.get(call.function.name), args)
            const validationError = validateCatalogToolArguments(call.function.name, args)
            const prepared = validationError ? { arguments: args, error: validationError } : pagination.prepare(call.function.name, args)
            args = prepared.arguments
            // Composite tools retain their own arguments in the model transcript;
            // the trace records only the underlying, real MCP invocations.
            call.function.arguments = JSON.stringify(args)
            let result: any
            if (prepared.error) {
                result = prepared.error
                await onProgress?.({ stage: 'assistant_message', content: validationError
                    ? 'Запрос не отправлен в MCP: конфликтующие параметры инструмента.'
                    : 'Запрос с неподтверждённым курсором не отправлен в MCP. Проверяю параметры пагинации.' })
            } else if (call.function.name === exactCodeTool) {
                if (!Number.isSafeInteger(args.catalogId) || args.catalogId < 1 || typeof args.code !== 'string' || !args.code.trim()
                    || Object.keys(args).some(key => key !== 'catalogId' && key !== 'code')) throw new Error('AI_INVALID_TOOL')
                result = await invoke('product_search', { catalogId: args.catalogId, code: args.code, limit: 2 })
                if (result.isError !== true) {
                    const products = result.structuredContent?.products
                    const matches = Array.isArray(products) ? products.filter(product => product?.code === args.code) : []
                    if (matches.length === 1 && Number.isSafeInteger(matches[0].id) && matches[0].id > 0) {
                        result = await invoke('product_get', { catalogId: args.catalogId, productId: matches[0].id })
                    } else {
                        result = { isError: true, content: [{ type: 'text', text: 'Exact product code was not found uniquely. Do not guess a product ID.' }] }
                    }
                }
            } else {
                result = await invoke(call.function.name, args)
            }
            if (result.isError === true && result.structuredContent?.error?.code === 'INVALID_CURSOR' && args.cursor !== undefined
                && schemas.get(call.function.name)?.properties?.cursor && !schemas.get(call.function.name)?.required?.includes('cursor')) {
                const firstPage = { ...args }
                delete firstPage.cursor
                delete firstPage.offset
                result = { ...result, aiChatRecovery: { suggestedCall: { name: call.function.name, arguments: firstPage },
                    notice: 'MCP rejected this cursor. Do not repeat it. The suggested call restarts the first page; it is not the next page.' } }
            }
            if (result.isError === true && canLookupCode && call.function.name === 'product_search'
                && Number.isSafeInteger(args.catalogId) && args.catalogId > 0 && typeof args.code === 'string' && args.code.trim()) {
                result = { ...result, aiChatRecovery: { suggestedCall: { name: exactCodeTool,
                    arguments: { catalogId: args.catalogId, code: args.code } } } }
            }
            const raw = JSON.stringify(sanitizeResponseDetails(modelCatalogResult(result), config))
            const resultLimit = config.limits.maxToolResultChars
            if (raw.length > resultLimit) await onProgress?.({ stage: 'assistant_message', modelTruncated: true,
                content: 'Структурированный результат превышает лимит одного ответа для модели. Передан неполный preview; подробности MCP сохранены отдельно.' })
            const content = raw.length > resultLimit ? JSON.stringify({ truncated: true, isError: result.isError === true,
                notice: 'Structured result exceeds the per-result size limit. Reduce page size or narrow the query. The preview is incomplete, not an empty result.',
                preview: raw.slice(0, resultLimit) }) : raw
            await append({ role: 'tool', tool_call_id: call.id, content })
        }
    }
    throw new Error('AI_LIMIT')
}
