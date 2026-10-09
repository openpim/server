import type Context from '../../context'
import type { ConfigAccess } from '../../context'
import type { ModelManager } from '../../models/manager'
import { buildMappingRequests, MappingAIConfig, MappingRequest, MappingSuggestion, MappingVisibilityContext, suggestMappings } from './mapping'
import { enrichMappingRequests, loadMarketplaceDictionary, LoadPIMDictionaries } from './values'
import { buildMappingReview } from './review'
import { yandexGeneralFields } from './yandexFields'

type MappingContext = Pick<Context, 'checkAuth' | 'getCurrentUser' | 'canEditConfig' | 'canEditChannel' | 'canViewChannel'>
type MappingManager = Pick<ModelManager, 'getChannels' | 'getLanguages' | 'getAttributesInfo'>
const supportedTypes = [2, 3, 9]
const activeTenants = new Set<string>()

export function authorizeMapping(context: MappingContext, manager: MappingManager, channelId: string, requireSupported: boolean, configAccess: ConfigAccess) {
    context.checkAuth()
    const user = context.getCurrentUser()!
    const channel = /^\d+$/.test(channelId) ? manager.getChannels().find(row => row.id === Number(channelId) && row.tenantId === user.tenantId) : null
    if (!channel) throw new Error('AI mapping channel not found.')
    if (!context.canEditConfig(configAccess) || !context.canViewChannel(channel.identifier) || !context.canEditChannel(channel.identifier)) throw new Error('Insufficient permissions for AI mapping.')
    if (requireSupported && !supportedTypes.includes(channel.type)) throw new Error('AI mapping channel type is not supported.')
    return channel
}

export async function withTenantMappingLock<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    if (activeTenants.has(tenantId)) throw new Error('An AI mapping request is already running for this tenant.')
    activeTenants.add(tenantId)
    try { return await operation() } finally { activeTenants.delete(tenantId) }
}

interface SuggestionArguments {
    channelId: string
    categoryId: string
    mappingKey: string
    language: string
    attributeIds: string[]
    groupIdentifier?: string | null
}

type MappingHandlerFactory = (channel: any) => { getAttributes(channel: any, categoryId: string): Promise<any[]> }
type Suggest = (requests: MappingRequest[], config: MappingAIConfig, context: { category?: string; language?: string; marketplace?: string }) => Promise<MappingSuggestion[]>
type LoadVisibilityPaths = (ids: string[], tenantId: string, relationId: number | null) => Promise<string[] | { paths: string[]; targetPaths: string[] }>

export async function resolveMappingSuggestions(context: MappingContext, manager: MappingManager, args: SuggestionArguments, config: MappingAIConfig,
    getHandler: MappingHandlerFactory, suggest: Suggest = suggestMappings, configAccess: ConfigAccess, loadVisibilityPaths?: LoadVisibilityPaths,
    loadPIMDictionaries?: LoadPIMDictionaries): Promise<MappingSuggestion[]> {
    const channel = authorizeMapping(context, manager, args.channelId, true, configAccess)
    if (!config.enabled) throw new Error('AI mapping is disabled.')
    if (typeof args.categoryId !== 'string' || !args.categoryId || args.categoryId.length > 250 || typeof args.mappingKey !== 'string' || !args.mappingKey || args.mappingKey.length > 250) throw new Error('Invalid AI mapping category.')
    if (!manager.getLanguages().some(language => language.identifier === args.language)) throw new Error('Invalid AI mapping language.')
    if (!Array.isArray(args.attributeIds) || args.attributeIds.length === 0 || args.attributeIds.length > 200 || args.attributeIds.some(id => typeof id !== 'string' || !id || id.length > 250)) throw new Error('Invalid AI mapping attribute IDs (1–200).')
    const storedCategory = Object.prototype.hasOwnProperty.call(channel.mappings, args.mappingKey) ? channel.mappings[args.mappingKey] : null
    if (storedCategory && (storedCategory.deleted || String(storedCategory.id) !== args.categoryId)) throw new Error('AI mapping category changed; reload the channel.')
    return withTenantMappingLock(channel.tenantId, async () => {
        let visibility: MappingVisibilityContext | undefined
        if (Array.isArray(storedCategory?.visible) && storedCategory.visible.length) {
            const ids = [...new Set<string>(storedCategory.visible.map(String))]
            if (ids.some(id => !/^[1-9]\d*$/.test(id)) || !loadVisibilityPaths) throw new Error('AI mapping category visibility is unavailable; reload the channel.')
            const relation = storedCategory.visibleRelation
            if (relation != null && !/^[1-9]\d*$/.test(String(relation))) throw new Error('Invalid AI mapping visibility relation.')
            const relationId = relation == null ? null : Number(relation)
            const loaded = await loadVisibilityPaths(ids, channel.tenantId, relationId)
            const paths = Array.isArray(loaded) ? loaded : loaded.paths
            const targetPaths = Array.isArray(loaded) ? undefined : loaded.targetPaths
            if ([...paths, ...(targetPaths || [])].some(path => !/^\d+(\.\d+)*$/.test(path)) || !ids.every(id => paths.some(path => path.split('.').pop() === id))) throw new Error('AI mapping category visibility is unavailable; reload the channel.')
            visibility = { paths, targetPaths, relationId }
        }
        const requestedIds = [...new Set(args.attributeIds)].filter(id => !id.startsWith('#'))
        const generalFields = channel.type === 9 ? yandexGeneralFields : []
        const attributes = requestedIds.some(id => !generalFields.some(field => field.id === id))
            ? await getHandler(channel).getAttributes(channel, args.categoryId) : []
        const selectedAttributes = requestedIds.map(id => {
            const attribute = generalFields.find(row => row.id === id) || attributes.find(row => row.id === id)
            if (!attribute) throw new Error('Unknown AI mapping marketplace attribute identifier.')
            return attribute
        })
        const allGroups = manager.getAttributesInfo()
        if (args.groupIdentifier != null && (typeof args.groupIdentifier !== 'string' || !args.groupIdentifier || args.groupIdentifier.length > 250)) throw new Error('Invalid AI mapping group.')
        const groups = args.groupIdentifier == null ? allGroups : allGroups.filter(group => group.identifier === args.groupIdentifier && group.visible)
        if (args.groupIdentifier != null && groups.length !== 1) throw new Error('AI mapping group is unavailable or ambiguous.')
        const baseRequests = buildMappingRequests(groups, selectedAttributes, args.language, storedCategory?.valid?.length ? storedCategory.valid : channel.valid, visibility)
        const metadataDeadline = Date.now() + 10000
        const requests = await enrichMappingRequests(baseRequests, allGroups, selectedAttributes, args.language, channel.tenantId, loadPIMDictionaries,
            attribute => loadMarketplaceDictionary(attribute, config, metadataDeadline - Date.now()))
        const categoryName = typeof storedCategory?.name === 'string' ? storedCategory.name : storedCategory?.name?.[args.language]
        const suggestions = await suggest(requests, config, { category: String(categoryName || args.categoryId).slice(0, 500), language: args.language,
            marketplace: ({ 2: 'Wildberries', 3: 'Ozon', 9: 'Yandex Market' } as Record<number, string>)[channel.type] })
        return suggestions.map(suggestion => {
            const request = requests.find(request => request.attribute.id === suggestion.id)
            if (!request) throw new Error('Invalid AI mapping suggestion scope.')
            const review = buildMappingReview(request, suggestion)
            const options = [suggestion, ...(suggestion.alternatives || [])].filter(option => option.attrIdent && request.candidates.some(candidate => candidate.attrIdent === option.attrIdent))
                .map((option, index) => ({ attrIdent: option.attrIdent, reason: option.reason, needsReview: true, recommended: index === 0 && option.attrIdent === suggestion.attrIdent,
                    review: buildMappingReview(request, { ...suggestion, ...option, needsReview: true }) }))
            if (options.length > 1 || (!suggestion.attrIdent && options.length)) Object.assign(review, { options })
            return { ...suggestion, needsReview: suggestion.needsReview || options.length > 1 || review.kind !== 'direct' || selectedAttributes.some(row => row.id === suggestion.id && row.aiMappingScope === 'general'), review }
        })
    })
}
