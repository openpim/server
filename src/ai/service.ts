import { randomUUID } from 'crypto'
import { Op, QueryTypes, Transaction } from 'sequelize'
import Context from '../context'
import { sequelize } from '../models'
import { AiChat, AiChatMessage } from '../models/aiChat'
import { ModelManager, ModelsManager } from '../models/manager'
import { ChatIdentity, hasChatAccess, readChatConfig, uuidPattern } from './config'
import { buildHistory } from './history'
import { catalogSystemPrompt } from './catalogArguments'
import { sanitizeResponseDetails } from './responseDetails'
import { connectCatalog, OpenAICompatibleProvider, runConversation, CatalogClient } from './runtime'

const controllers = new Map<string, AbortController>()

export function canAccess(user: ChatIdentity | null | undefined): boolean {
    const roles = user ? ModelsManager.getInstance().getModelManager(String(user.tenantId))?.getUsers()
        .find(current => current.getUser().id === user.id)?.getRoles() || [] : []
    return hasChatAccess(ModelManager.getServerConfig(), user, roles)
}

export function identity(context: Context): ChatIdentity {
    context.checkAuth()
    const user = context.getCurrentUser()!
    const current = { id: user.id, tenantId: String(user.tenantId) }
    if (!canAccess(current)) throw new Error('AI-чат недоступен')
    return current
}

function assertId(id: string): void {
    if (!uuidPattern.test(id)) throw new Error('Неверный идентификатор')
}
function owner(user: ChatIdentity) { return { tenantId: user.tenantId, userId: user.id } }

async function ownedChat(user: ChatIdentity, id: string, transaction?: Transaction): Promise<AiChat> {
    assertId(id)
    const chat = await AiChat.findOne({ where: { id, ...owner(user) }, transaction,
        ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) })
    if (!chat) throw new Error('Чат не найден')
    return chat
}

// A transaction-scoped PostgreSQL lock serializes admissions and cleanup across server replicas.
async function admissionLock(transaction: Transaction): Promise<void> {
    await sequelize.query('SELECT pg_advisory_xact_lock(174921, 1)', { transaction, type: QueryTypes.SELECT })
}
async function recoverExpired(transaction?: Transaction): Promise<void> {
    await AiChatMessage.update({ status: 'error', error: 'Обработка прервана или истекло время ожидания', runId: null, leaseUntil: null }, {
        where: { status: 'running', leaseUntil: { [Op.lt]: new Date() } }, transaction
    })
}

export async function listChats(user: ChatIdentity, offset: number, limit: number) {
    const result = await AiChat.findAndCountAll({ where: owner(user), order: [['updatedAt', 'DESC'], ['id', 'DESC']], offset, limit })
    return { rows: result.rows, total: result.count }
}
export async function listMessages(user: ChatIdentity, chatId: string, offset: number, limit: number) {
    await ownedChat(user, chatId)
    await recoverExpired()
    // Newest page first at the DB boundary; each page is returned in display order.
    const result = await AiChatMessage.findAndCountAll({ where: { chatId, ...owner(user) },
        order: [['createdAt', 'DESC'], ['id', 'DESC']], offset, limit })
    return { rows: result.rows.reverse(), total: result.count }
}
export async function createChat(user: ChatIdentity) {
    return AiChat.create({ ...owner(user), title: 'Новый чат' })
}
export async function renameChat(user: ChatIdentity, id: string, title: string) {
    if (!title.trim() || title.trim().length > 250) throw new Error('Название должно содержать от 1 до 250 символов')
    return sequelize.transaction(async transaction => {
        const chat = await ownedChat(user, id, transaction)
        return chat.update({ title: title.trim() }, { transaction })
    })
}
export async function deleteChat(user: ChatIdentity, id: string) {
    await sequelize.transaction(async transaction => {
        await admissionLock(transaction)
        const chat = await ownedChat(user, id, transaction)
        const messages = await AiChatMessage.findAll({ where: { chatId: id, status: 'running' }, transaction })
        for (const message of messages) controllers.get(message.id)?.abort()
        await AiChatMessage.destroy({ where: { chatId: id }, transaction })
        await chat.destroy({ transaction })
    })
    return true
}

async function checkCapacity(user: ChatIdentity, transaction: Transaction): Promise<void> {
    const config = readChatConfig(ModelManager.getServerConfig())
    await recoverExpired(transaction)
    const active = await AiChatMessage.count({ where: { status: 'running' }, transaction })
    const mine = await AiChatMessage.count({ where: { ...owner(user), status: 'running' }, transaction })
    if (mine >= config.limits.maxConcurrentRequestsPerUser) throw new Error('Дождитесь ответа или остановите текущий запрос')
    if (active >= config.limits.maxConcurrentRequests) throw new Error('AI-чат занят. Повторите позже')
}
function runValues() {
    const config = readChatConfig(ModelManager.getServerConfig())
    return { status: 'running', runId: randomUUID(), leaseUntil: new Date(Date.now() + config.limits.requestTimeoutMs + 10000), error: null }
}

export async function sendMessage(user: ChatIdentity, chatId: string, content: string, requestId: string) {
    assertId(requestId)
    const config = readChatConfig(ModelManager.getServerConfig())
    if (!content.trim() || content.length > config.limits.maxInputChars) throw new Error(`Сообщение должно содержать от 1 до ${config.limits.maxInputChars} символов`)
    let start = false
    const response = await sequelize.transaction(async transaction => {
        await admissionLock(transaction)
        const chat = await ownedChat(user, chatId, transaction)
        const existing = await AiChatMessage.findOne({ where: { ...owner(user), requestId }, transaction })
        if (existing) {
            if (existing.chatId !== chatId || existing.content !== content.trim()) throw new Error('Идентификатор отправки уже использован')
            const reply = await AiChatMessage.findOne({ where: { replyToId: existing.id }, transaction })
            if (!reply) throw new Error('Ответ не найден')
            return reply
        }
        await checkCapacity(user, transaction)
        const latest = await AiChatMessage.findOne({ where: { chatId }, order: [['createdAt', 'DESC']], transaction })
        const createdAt = new Date(Math.max(Date.now(), latest ? latest.createdAt.getTime() + 1 : 0))
        const input = await AiChatMessage.create({ chatId, ...owner(user), role: 'user', content: content.trim(), status: 'completed', requestId, createdAt }, { transaction })
        const reply = await AiChatMessage.create({ chatId, ...owner(user), role: 'assistant', replyToId: input.id,
            ...runValues(), createdAt: new Date(createdAt.getTime() + 1) }, { transaction })
        await chat.update({ ...(!latest ? { title: content.trim().replace(/\s+/g, ' ').slice(0, 80) } : {}), updatedAt: new Date() }, { transaction })
        start = true
        return reply
    })
    if (start) schedule(response, user)
    return response
}
export async function retryMessage(user: ChatIdentity, id: string) {
    assertId(id)
    const response = await sequelize.transaction(async transaction => {
        await admissionLock(transaction)
        const message = await AiChatMessage.findOne({ where: { id, ...owner(user), role: 'assistant' }, transaction })
        if (!message) throw new Error('Ответ не найден')
        await ownedChat(user, message.chatId, transaction)
        if (!['error', 'cancelled'].includes(message.status)) throw new Error('Этот ответ нельзя повторить')
        const newer = await AiChatMessage.count({ where: { chatId: message.chatId, role: 'user',
            createdAt: { [Op.gt]: message.createdAt } }, transaction })
        if (newer) throw new Error('Можно повторить только последний ответ')
        await checkCapacity(user, transaction)
        return message.update({ ...runValues(), content: '', trace: [], contextTruncated: false }, { transaction })
    })
    schedule(response, user)
    return response
}
export async function cancelMessage(user: ChatIdentity, id: string) {
    assertId(id)
    const [changed] = await AiChatMessage.update({ status: 'cancelled', error: null, runId: null, leaseUntil: null },
        { where: { id, ...owner(user), role: 'assistant', status: 'running' } })
    if (!changed) {
        const message = await AiChatMessage.findOne({ where: { id, ...owner(user) } })
        if (!message) throw new Error('Ответ не найден')
    }
    controllers.get(id)?.abort()
    return true
}

function schedule(message: AiChatMessage, user: ChatIdentity): void {
    const runId = message.runId!
    setImmediate(() => { void execute(message.id, runId, user).catch(() => {
        // Do not log provider payloads, URLs or credentials. The persisted state is authoritative.
    }) })
}

async function execute(id: string, runId: string, user: ChatIdentity): Promise<void> {
    const controller = new AbortController()
    controllers.set(id, controller)
    let catalog: CatalogClient | undefined
    let timeout: NodeJS.Timeout | undefined
    let monitor: NodeJS.Timeout | undefined
    let checking = false
    let timedOut = false
    const trace: any[] = []
    const where = { id, runId, status: 'running', ...owner(user) }
    try {
        const config = readChatConfig(ModelManager.getServerConfig())
        const current = await AiChatMessage.findOne({ where })
        if (!current) return
        const check = async () => {
            if (controller.signal.aborted) throw new Error(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED')
            if (!canAccess(user)) throw new Error('AI_ACCESS_REVOKED')
            if (!await AiChatMessage.findOne({ where, attributes: ['id'] })) throw new Error('AI_CANCELLED')
        }
        const remainingMs = Math.min(config.limits.requestTimeoutMs, current.leaseUntil!.getTime() - Date.now() - 10000)
        if (remainingMs <= 0) throw new Error('AI_TIMEOUT')
        timeout = setTimeout(() => { timedOut = true; controller.abort() }, remainingMs)
        monitor = setInterval(() => {
            if (checking) return
            checking = true
            void check().catch(() => controller.abort()).finally(() => { checking = false })
        }, 1000)
        await check()
        const input = await AiChatMessage.findOne({ where: { id: current.replyToId!, chatId: current.chatId, role: 'user', ...owner(user) } })
        if (!input) throw new Error('AI_CANCELLED')
        // Bound the DB read too; count determines whether older history was omitted.
        const previousWhere = { chatId: current.chatId, ...owner(user), role: 'assistant', status: 'completed', createdAt: { [Op.lt]: current.createdAt } }
        const previous = await AiChatMessage.findAll({ where: previousWhere, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: config.limits.maxHistoryTurns })
        const total = await AiChatMessage.count({ where: previousWhere })
        const inputs = await AiChatMessage.findAll({ where: { chatId: current.chatId, ...owner(user), role: 'user', id: { [Op.in]: previous.map(row => row.replyToId!) } } })
        const byId = new Map(inputs.map(row => [row.id, row.content]))
        const history = buildHistory(previous.reverse().filter(row => byId.has(row.replyToId!)).map(row => ({
            input: byId.get(row.replyToId!)!, output: row.content, trace: row.trace
        })), config, total)
        const contextTruncated = history.truncated
        await AiChatMessage.update({ contextTruncated }, { where })
        const messages: any[] = [{ role: 'system', content: catalogSystemPrompt }, ...history.messages]
        messages.push({ role: 'user', content: input.content })
        await check()
        const onProgress = async (event?: any) => {
            await check()
            if (event) trace.push(sanitizeResponseDetails({ kind: 'progress', ...event, at: new Date().toISOString() }, config))
            const [updated] = await AiChatMessage.update({ trace, ...(event?.contextTruncated ? { contextTruncated: true } : {}) }, { where })
            if (!updated) throw new Error('AI_CANCELLED')
        }
        await onProgress({ stage: 'catalog_connect' })
        catalog = await connectCatalog(config, controller.signal)
        const content = await runConversation({ config, provider: new OpenAICompatibleProvider(config), catalog,
            messages, catalogHistory: history.catalogHistory, signal: controller.signal, check, trace, onProgress })
        await check()
        // Admission lock and chat row lock make completion atomic with deletion/admission.
        await sequelize.transaction(async transaction => {
            await admissionLock(transaction)
            const chat = await AiChat.findOne({ where: { id: current.chatId, ...owner(user) }, transaction, lock: transaction.LOCK.UPDATE })
            if (!chat || !canAccess(user) || controller.signal.aborted) return
            const [updated] = await AiChatMessage.update({ content, trace, status: 'completed', runId: null, leaseUntil: null }, { where, transaction })
            if (updated) await chat.update({ updatedAt: new Date() }, { transaction })
        })
    } catch (error) {
        const code = timedOut ? 'AI_TIMEOUT' : (error as Error).message
        const errors: Record<string, string> = {
            AI_TIMEOUT: 'Истекло время ожидания ответа', AI_CANCELLED: 'Обработка остановлена',
            AI_ACCESS_REVOKED: 'Доступ к AI-чату отозван', AI_LIMIT: 'Достигнут лимит вызовов инструментов. Уточните вопрос',
            AI_CONTEXT_LIMIT: 'Текущие ответы инструментов не помещаются в контекст. Уменьшите объём одного запроса',
            AI_INVALID_TOOL: 'Модель запросила недопустимый инструмент', AI_PROVIDER_FAILED: 'Провайдер AI не смог сформировать ответ',
            AI_MCP_FAILED: 'Не удалось обратиться к каталогу'
        }
        await AiChatMessage.update({ status: code === 'AI_CANCELLED' ? 'cancelled' : 'error', error: errors[code] || 'Не удалось обработать запрос',
            trace, runId: null, leaseUntil: null }, { where })
    } finally {
        if (timeout) clearTimeout(timeout)
        if (monitor) clearInterval(monitor)
        if (controllers.get(id) === controller) controllers.delete(id)
        await catalog?.close().catch(() => {})
    }
}
