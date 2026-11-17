// Only reject a mutually exclusive combination documented by the MCP contract.
// Tool selection, attribute discovery and filter validity otherwise belong to MCP
// and the model's existing context; do not require a new workflow on every turn.
export function validateCatalogToolArguments(name: string, args: any): any | undefined {
    if (name !== 'category_search' || args.parentId == null || args.parentCode == null) return
    return { isError: true, content: [{ type: 'text', text:
        'AI chat rejected mutually exclusive parentId and parentCode before MCP. Choose at most one actual category parent, or omit both for no parent constraint. No argument was automatically chosen or removed.' }],
        structuredContent: { error: { code: 'INVALID_ARGUMENT_COMBINATION', retryable: false,
            details: { fields: ['parentId', 'parentCode'] } } },
        aiChatRecovery: { notice: 'Use the MCP tool schema and existing conversation context to correct the arguments. CatalogId is independent of the category parent selectors; this error does not require a category-restricted product search.' } }
}
