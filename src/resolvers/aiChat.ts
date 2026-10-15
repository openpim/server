import Context from '../context'
import { ModelManager } from '../models/manager'
import { readChatConfig } from '../ai/config'
import { sanitizeResponseDetails } from '../ai/responseDetails'
import * as chat from '../ai/service'

function page(offset = 0, limit = 50) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Неверные параметры страницы')
    return { offset, limit }
}
export default {
    AiChatMessage: {
        responseDetails: (message: any, _args: any, context: Context) => {
            const user = chat.identity(context)
            if (message.userId !== user.id || String(message.tenantId) !== user.tenantId) throw new Error('Ответ не найден')
            const visible = (message.trace || []).filter((entry: any) => entry?.kind === 'progress'
                || entry?.kind === 'mcp' || (!entry?.kind && typeof entry?.name === 'string'))
            return sanitizeResponseDetails(visible, readChatConfig(ModelManager.getServerConfig()))
        }
    },
    Query: {
        aiChatAvailability: (_: any, args: any, context: Context) => {
            context.checkAuth()
            const server = ModelManager.getServerConfig()
            if (!chat.canAccess(context.getCurrentUser())) return { available: false, maxInputChars: 0 }
            try { return { available: true, maxInputChars: readChatConfig(server).limits.maxInputChars } }
            catch { return { available: false, maxInputChars: 0 } }
        },
        aiChats: (_: any, args: any, context: Context) => {
            const user = chat.identity(context)
            const { offset, limit } = page(args.offset, args.limit)
            return chat.listChats(user, offset, limit)
        },
        aiChatMessages: (_: any, args: any, context: Context) => {
            const user = chat.identity(context)
            const { offset, limit } = page(args.offset, args.limit)
            return chat.listMessages(user, args.chatId, offset, limit)
        }
    },
    Mutation: {
        createAiChat: (_: any, args: any, context: Context) => chat.createChat(chat.identity(context)),
        renameAiChat: (_: any, args: any, context: Context) => chat.renameChat(chat.identity(context), args.id, args.title),
        deleteAiChat: (_: any, args: any, context: Context) => chat.deleteChat(chat.identity(context), args.id),
        sendAiChatMessage: (_: any, args: any, context: Context) => chat.sendMessage(chat.identity(context), args.chatId, args.content, args.requestId),
        retryAiChatMessage: (_: any, args: any, context: Context) => chat.retryMessage(chat.identity(context), args.id),
        cancelAiChatMessage: (_: any, args: any, context: Context) => chat.cancelMessage(chat.identity(context), args.id)
    }
}
