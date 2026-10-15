import { ChatConfig } from './config'
import { sanitizeResponseDetails } from './responseDetails'
import { modelCatalogResult } from './modelContext'
import { catalogToolNames } from './runtime'

export interface HistoryTurn { input: string; output: string; trace?: any[] }
export interface CatalogHistoryCall { name: string; arguments: any; result: any }

const incompleteNotice = { role: 'system', content:
    'Some earlier conversation or MCP results were omitted to fit context limits. Missing records are not evidence that catalog data or attributes do not exist.' }
const cost = (messages: any[]) => messages.reduce((size, message) => size + JSON.stringify(message).length + 1, 0)
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Reconstruct only actual MCP invocations, not provider envelopes or inferred calls.
// Replay IDs link the restored transcript; they are not original provider call IDs.
export function buildHistory(turns: HistoryTurn[], config: ChatConfig, totalTurns = turns.length): {
    messages: any[]; truncated: boolean; catalogHistory: CatalogHistoryCall[]
} {
    const limit = config.limits.maxHistoryChars
    const budget = Math.max(0, limit - cost([incompleteNotice]))
    let used = 2 // JSON array framing; cost() slightly overcounts separators.
    const selected: { turn: HistoryTurn; index: number; blocks: { messages: any[]; record: CatalogHistoryCall }[] }[] = []
    for (let index = turns.length - 1; index >= 0; index--) {
        const turn = turns[index]
        const size = cost([{ role: 'user', content: turn.input }, { role: 'assistant', content: turn.output }])
        if (selected.length >= config.limits.maxHistoryTurns || used + size > budget) break
        selected.unshift({ turn, index, blocks: [] })
        used += size
    }
    let truncated = selected.length < totalTurns
    // Keep text pairs first, then newest complete call/result pairs. Never cut JSON.
    for (const item of [...selected].reverse()) {
        const trace = Array.isArray(item.turn.trace) ? item.turn.trace : []
        for (let index = trace.length - 1; index >= 0; index--) {
            const entry = trace[index]
            if (!entry || (entry.kind != null && entry.kind !== 'mcp') || !catalogToolNames.has(entry.name)
                || entry.status === 'running' || !object(entry.arguments) || entry.result == null) continue
            if (entry.truncated || (typeof entry.result === 'string' && entry.result.length > config.limits.maxStoredToolResultChars)) {
                truncated = true
                continue
            }
            let result: any
            try { result = typeof entry.result === 'string' ? JSON.parse(entry.result) : entry.result } catch { truncated = true; continue }
            if (!object(result) || result.truncated || (!Array.isArray(result.content) && !object(result.structuredContent))
                || (entry.status === 'error' && result.isError !== true)) { truncated = true; continue }
            const record: CatalogHistoryCall = sanitizeResponseDetails({ name: entry.name, arguments: entry.arguments, result }, config)
            const modelResult = JSON.stringify(modelCatalogResult(record.result))
            if (modelResult.length > config.limits.maxToolResultChars) { truncated = true; continue }
            const id = `saved_mcp_${item.index}_${index}`
            const messages = [{ role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
                function: { name: record.name, arguments: JSON.stringify(record.arguments) } }] },
                { role: 'tool', tool_call_id: id, content: modelResult }]
            const size = cost(messages)
            if (used + size > budget) { truncated = true; continue }
            used += size
            item.blocks.unshift({ messages, record })
        }
    }
    const messages: any[] = []
    const catalogHistory: CatalogHistoryCall[] = []
    if (truncated && cost([incompleteNotice]) + 2 <= limit) messages.push(incompleteNotice)
    for (const item of selected) {
        messages.push({ role: 'user', content: item.turn.input })
        for (const block of item.blocks) {
            messages.push(...block.messages)
            catalogHistory.push(block.record)
        }
        messages.push({ role: 'assistant', content: item.turn.output })
    }
    return { messages, truncated, catalogHistory }
}
