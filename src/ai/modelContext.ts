// Prefer MCP's machine-readable result in model context. The complete native
// envelope (including narration/resource links) is persisted separately for UI.
export function modelCatalogResult(result: any): any {
    if (result?.isError === true || !result?.structuredContent || typeof result.structuredContent !== 'object'
        || Array.isArray(result.structuredContent) || !Object.keys(result.structuredContent).length || !Array.isArray(result.content)) return result
    const content = result.content.filter((item: any) => item.type !== 'text' && item.type !== 'resource_link')
    if (content.length === result.content.length) return result
    return { ...result, content, aiChatPresentation: {
        notice: 'structuredContent is the complete structured MCP result as returned. Accompanying text and resource links are retained in saved MCP details, not repeated in model context.'
    } }
}

const omissionNotice = 'Earlier conversation or complete tool exchanges were omitted to fit the context budget. This does not mean catalog data is missing. The latest tool result is retained; only an explicit truncated flag means its data is incomplete.'

// Free old context rather than progressively truncating each new result. Never
// split an assistant tool-call batch from its replies, or remove the active user.
export function appendModelMessage(messages: any[], message: any, limit: number): boolean {
    messages.push(message)
    let omitted = false
    while (JSON.stringify(messages).length > limit) {
        const users = messages.map((entry, index) => entry.role === 'user' ? index : -1).filter(index => index >= 0)
        let removed = false
        if (users.length >= 2) {
            messages.splice(users[0], users[1] - users[0])
            removed = true
        } else {
            let latestBatch = -1
            for (let i = 0; i < messages.length; i++) if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) latestBatch = i
            for (let i = 0; i < latestBatch; i++) {
                const calls = messages[i].role === 'assistant' && messages[i].tool_calls
                if (!Array.isArray(calls) || !calls.length) continue
                const ids = new Set(calls.map((call: any) => call.id))
                const replies = messages.slice(i + 1, i + 1 + calls.length)
                if (ids.size !== calls.length || replies.length !== calls.length
                    || new Set(replies.map(reply => reply.tool_call_id)).size !== calls.length
                    || !replies.every(reply => reply.role === 'tool' && ids.has(reply.tool_call_id))) continue
                messages.splice(i, calls.length + 1)
                removed = true
                break
            }
        }
        if (!removed) throw new Error('AI_CONTEXT_LIMIT')
        omitted = true
        if (!messages.some(entry => entry.role === 'system' && entry.content === omissionNotice)) {
            const first = messages.findIndex(entry => entry.role !== 'system')
            messages.splice(first < 0 ? messages.length : first, 0, { role: 'system', content: omissionNotice })
        }
    }
    return omitted
}
