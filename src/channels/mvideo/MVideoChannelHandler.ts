import { Channel } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import { Item } from '../../models/items'
import { ItemRelation } from '../../models/itemRelations'
import { sequelize } from '../../models'
import { Op } from 'sequelize'
import Context from '../../context'
import { EventType } from '../../models/actions'
import { processItemActions } from '../../resolvers/utils'
import fetch from 'node-fetch'
import NodeCache = require('node-cache')
import { createHash } from 'crypto'
import logger from '../../logger'

const API = 'https://api.sellers.mvideo.ru'
const TEXT_FIELDS = ['name', 'brand', 'model', 'vendorCode', 'color', 'tnvedCode', 'okpd2Code', 'description', 'fireHazardClass']
const ARRAY_FIELDS = ['barcodes', 'manufacturerCountries', 'deliveryScheme', 'pictures', 'manuals']
const YES_NO_FIELDS = ['generateBarcodes', 'isVerticalOnly', 'isFragile', 'marking']
const FINAL_TASKS = ['FAILED', 'SUCCEEDED_PARTIALLY', 'SUCCEEDED']
const empty = (value: any) => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)

interface PreparedOffer { item: Item; offer: any }

export class MVideoChannelHandler extends ChannelHandler {
    private cache = new NodeCache({ stdTTL: 600, useClones: false })
    private running = new Set<string>()

    private cacheKey(channel: Channel, path: string): string {
        return channel.tenantId + ':' + channel.id + ':' + createHash('sha256').update(channel.config.mvideoApiKey || '').digest('hex') + ':' + path
    }

    private async request(channel: Channel, method: string, path: string, body?: any): Promise<any> {
        if (!channel.config.mvideoApiKey || channel.config.mvideoApiKey === '*****') throw new Error('Не указан API-ключ МВидео с правом MATERIAL_CREATE')
        const blockedUntil = channel.runtime.mvideoRetryAt || 0
        if (blockedUntil > Date.now()) throw new Error('МВидео ограничил запросы до ' + new Date(blockedUntil).toISOString())
        const response = await fetch(API + path, {
            method,
            headers: { 'api-key': channel.config.mvideoApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            timeout: 30000,
        })
        const text = await response.text()
        if (response.status === 429) {
            const retry = response.headers.get('retry-after')
            const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 3600
            channel.runtime.mvideoRetryAt = retry && !/^\d+$/.test(retry) ? (Date.parse(retry) || Date.now() + 3600000) : Date.now() + seconds * 1000
            channel.changed('runtime', true)
            await channel.save()
        }
        if (response.status < 200 || response.status >= 300) throw new Error('МВидео HTTP ' + response.status + ': ' + text.slice(0, 2000))
        try { return JSON.parse(text) } catch (_) { throw new Error('МВидео вернул некорректный JSON') }
    }

    private async cached(channel: Channel, path: string): Promise<any> {
        const key = this.cacheKey(channel, path)
        const existing = this.cache.get(key)
        if (existing) return existing
        const result = await this.request(channel, 'GET', path)
        this.cache.set(key, result)
        return result
    }

    public async getCategories(channel: Channel): Promise<{ list: ChannelCategory[] | null; tree: ChannelCategory | null }> {
        const response = await this.cached(channel, '/v2/dictionaries/category')
        const categories = Array.isArray(response) ? response : response.result
        if (!Array.isArray(categories)) throw new Error('МВидео вернул некорректный справочник категорий')
        const list: ChannelCategory[] = []
        const convert = (category: any): ChannelCategory => {
            const children = (category.children || []).map(convert)
            const node = { id: String(category.categoryId), name: category.categoryName, ...(children.length ? { children } : {}) }
            if (!children.length) list.push(node)
            return node
        }
        const children = categories.map(convert)
        return { list, tree: { id: '', name: 'МВидео', children } }
    }

    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        this.categoryNumber(categoryId)
        const response = await this.cached(channel, '/v2/dictionaries/attribute?' + new URLSearchParams({ categoryId, salesScheme: 'MARKETPLACE' }))
        if (!Array.isArray(response.result)) throw new Error('МВидео вернул некорректный справочник характеристик')
        return response.result.map((attr: any) => ({
            id: String(attr.attributeId), name: attr.attributeName + (attr.attributeType === 'NUMBER' ? ' (Decimal)' : ''), type: attr.attributeType,
            required: !!attr.required, dictionary: attr.attributeType === 'LIST', isNumber: attr.attributeType === 'NUMBER',
            filtering: false, category: categoryId, description: [attr.attributeDescription, attr.attributeMeasureUnit].filter(Boolean).join('\n'),
            dictionaryLink: attr.attributeType === 'LIST' ? API + '/v2/dictionaries/attributeValues' : undefined,
            dictionaryLinkPost: attr.attributeType === 'LIST' ? { body: { filter: { categoryId, attributeId: attr.attributeId } } } : undefined,
        }))
    }

    private categoryNumber(id: string): number {
        if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error('Некорректный код категории МВидео: ' + id)
        return Number(id)
    }

    public async getChannelAttributeValues(channel: Channel, categoryId: string, attributeId: string): Promise<any> {
        this.categoryNumber(categoryId)
        if (!/^\d+$/.test(attributeId) || !Number.isSafeInteger(Number(attributeId))) throw new Error('Некорректный код характеристики МВидео')
        const key = this.cacheKey(channel, 'values:' + categoryId + ':' + attributeId)
        const cached = this.cache.get(key)
        if (cached) return cached
        const values: any[] = []
        const cursors = new Set<string>()
        let cursor: string | null = null
        let total = 0
        do {
            const response: any = await this.request(channel, 'POST', '/v2/dictionaries/attributeValues', {
                filter: { categoryId, attributeId: Number(attributeId) }, cursor, limit: 500,
            })
            if (!Array.isArray(response.attributeValues)) throw new Error('МВидео вернул некорректный список значений')
            values.push(...response.attributeValues.map((value: string) => ({ id: value, value })))
            total = response.total ?? values.length
            cursor = response.next_cursor || null
            if (cursor && cursors.has(cursor)) throw new Error('МВидео повторил курсор справочника')
            if (cursor) cursors.add(cursor)
        } while (cursor)
        const result = { values, total, has_next: false }
        this.cache.set(key, result)
        return result
    }

    private async findCategory(channel: Channel, item: Item): Promise<any> {
        for (const category of Object.values(channel.mappings) as any[]) {
            if (!category || category.deleted || !category.valid?.some((id: any) => Number(id) === item.typeId)) continue
            let matches = false
            if (category.visible?.length) {
                if (category.visibleRelation) {
                    const sources = await Item.findAll({
                        where: { tenantId: channel.tenantId, '$sourceRelation.relationId$': category.visibleRelation, '$sourceRelation.targetId$': item.id },
                        include: [{ model: ItemRelation, as: 'sourceRelation' }],
                    })
                    matches = sources.some(source => category.visible.some((id: any) => source.path.split('.').includes(String(id))))
                } else matches = category.visible.some((id: any) => item.path.split('.').includes(String(id)))
            } else if (category.categoryExpr) matches = !!await this.evaluateExpression(channel, item, category.categoryExpr)
            else if (category.categoryAttr && category.categoryAttrValue !== undefined) matches = String(item.values[category.categoryAttr]) === String(category.categoryAttrValue)
            if (matches) return category
        }
        throw new Error('Товар не подходит ни под одну категорию канала МВидео')
    }

    private async buildOffer(channel: Channel, item: Item, category: any, language: string): Promise<any> {
        const get = async (id: string) => this.getValueByMapping(channel, (category.attributes || []).find((attr: any) => attr.id === id), item, language)
        const mappedOfferId = await get('#offerId')
        const offerId = mappedOfferId ?? (channel.config.mvideoOfferIdAttr ? item.values[channel.config.mvideoOfferIdAttr] : item.identifier)
        if (empty(offerId)) throw new Error('Не заполнен offerId товара')
        const offer: any = { offerId: String(offerId), categoryId: this.categoryNumber(String(category.id)), salesScheme: 'MARKETPLACE' }
        for (const field of TEXT_FIELDS) {
            const value = await get('#' + field)
            if (!empty(value)) offer[field] = String(value)
        }
        for (const field of ['name', 'brand']) if (empty(offer[field])) throw new Error('Не заполнено обязательное поле: ' + field)
        for (const field of ARRAY_FIELDS) {
            const value = await get('#' + field)
            if (!empty(value)) offer[field] = (Array.isArray(value) ? value : [value]).map(String)
        }
        for (const field of YES_NO_FIELDS) {
            const value = await get('#' + field)
            if (!empty(value)) {
                const normalized = value === true ? 'Да' : value === false ? 'Нет' : String(value)
                if (!['Да', 'Нет'].includes(normalized)) throw new Error(field + ': ожидается Да/Нет или Boolean')
                offer[field] = normalized
            }
        }
        for (const field of ['warrantyPeriod', 'weightDimensions']) {
            const value = await get('#' + field)
            if (!empty(value)) {
                if (typeof value !== 'object' || Array.isArray(value)) throw new Error(field + ': ожидается объект согласно OpenAPI')
                offer[field] = field === 'warrantyPeriod'
                    ? { timePeriod: String(value.timePeriod), timeUnit: value.timeUnit }
                    : Object.fromEntries(['length', 'width', 'height', 'weight'].map(key => [key, String(value[key])]))
            }
        }
        const vat = await get('#vat')
        if (!empty(vat)) {
            if (![0, 5, 7, 10, 22].includes(Number(vat))) throw new Error('Недопустимая ставка НДС: ' + vat)
            offer.vat = Number(vat)
        }
        this.validateOffer(offer)
        const attributes = await this.getAttributes(channel, String(category.id))
        offer.attributes = []
        for (const attribute of attributes) {
            const value = await get(attribute.id)
            if (empty(value)) {
                if (attribute.required) throw new Error('Не заполнена обязательная характеристика: ' + attribute.name)
                continue
            }
            if (Array.isArray(value) || typeof value === 'object') throw new Error(attribute.name + ': ожидается одно значение')
            if (attribute.isNumber && !Number.isFinite(Number(String(value).replace(',', '.')))) throw new Error(attribute.name + ': ожидается число')
            if (attribute.dictionary) {
                const dictionary = await this.getChannelAttributeValues(channel, String(category.id), attribute.id)
                if (!dictionary.values.some((entry: any) => entry.value === String(value))) throw new Error('Значение отсутствует в справочнике МВидео: ' + attribute.name + ' — ' + value)
            }
            const attributeValue = attribute.type === 'BOOLEAN' && typeof value === 'boolean' ? (value ? 'Да' : 'Нет') : String(value)
            offer.attributes.push({ attributeId: Number(attribute.id), attributeValue })
        }
        return offer
    }

    private validateOffer(offer: any): void {
        const limits: Record<string, number> = { offerId: 250, name: 249, brand: 250, model: 250, vendorCode: 35, color: 50, description: 1500 }
        for (const field in limits) if (offer[field]?.length > limits[field]) throw new Error(field + ': превышена длина ' + limits[field])
        for (const [field, max] of Object.entries({ barcodes: 3, manufacturerCountries: 1, pictures: 15, manuals: 5 })) {
            if (offer[field]?.length > max) throw new Error(field + ': максимум ' + max + ' значений')
        }
        if (offer.barcodes?.some((code: string) => !/^\d{13}$/.test(code))) throw new Error('Штрихкод должен содержать 13 цифр')
        if (offer.tnvedCode && !/^\d{1,10}$/.test(offer.tnvedCode)) throw new Error('Код ТНВЭД должен содержать до 10 цифр')
        if (offer.fireHazardClass && !['4', '5', '6', '7', '8', '9', 'Нет'].includes(offer.fireHazardClass)) throw new Error('Недопустимый класс пожароопасности')
        if (offer.deliveryScheme?.some((scheme: string) => !['FBS', 'FBM', 'DBS'].includes(scheme))) throw new Error('Недопустимая схема поставки')
        if (offer.warrantyPeriod) {
            const period = offer.warrantyPeriod
            if (!/^\d{1,2}$/.test(String(period.timePeriod)) || !['MONTH', 'YEAR'].includes(period.timeUnit)) throw new Error('Некорректный гарантийный период')
        }
        if (offer.weightDimensions) {
            for (const field of ['length', 'width', 'height', 'weight']) {
                if (!/^\d+([.,]\d{1,3})?$/.test(String(offer.weightDimensions[field]))) throw new Error('Некорректные габариты: ' + field)
            }
        }
        for (const field of ['pictures', 'manuals']) {
            if (offer[field]?.some((url: string) => !/^https?:\/\/\S+$/i.test(url))) throw new Error(field + ': ожидаются ссылки HTTP(S)')
        }
    }

    private async saveState(channel: Channel, item: Item, state: any, values: any = {}): Promise<void> {
        const ctx = Context.createAs('admin', channel.tenantId)
        const source = { updateFromMVideo: channel.identifier }
        const saved = await sequelize.transaction(async transaction => {
            const current = await Item.findOne({ where: { id: item.id, tenantId: channel.tenantId }, transaction, lock: transaction.LOCK.UPDATE })
            if (!current) throw new Error('Товар не найден: ' + item.id)
            const channels = { [channel.identifier]: { ...current.channels[channel.identifier], ...state } }
            await processItemActions(ctx, EventType.BeforeUpdate, current, current.parentIdentifier, current.name, values, channels, false, false, false, transaction, source)
            if (Object.keys(values).length) {
                current.values = { ...current.values, ...values }
                current.changed('values', true)
            }
            current.channels = { ...current.channels, ...channels }
            current.changed('channels', true)
            await current.save({ transaction })
            return current
        })
        if (saved) await processItemActions(ctx, EventType.AfterUpdate, saved, saved.parentIdentifier, saved.name, saved.values, saved.channels, false, false, false, null, source)
    }

    public async processChannel(channel: Channel, language: string, data: any, _context?: Context): Promise<void> {
        const key = channel.tenantId + ':' + channel.id
        if (this.running.has(key)) return
        this.running.add(key)
        let log = ''
        try {
            const execution = await this.createExecution(channel)
            try {
                if (data?.clearCache) {
                    this.cache.flushAll()
                    await this.clearLOVCache()
                    await this.finishExecution(channel, execution, 2, 'Кеш МВидео очищен')
                    return
                }
                if (!channel.config.mvideoApiKey) throw new Error('Не указан API-ключ МВидео')
                if (!channel.config.mvideoIdAttr) throw new Error('Не указан атрибут для productId МВидео')
                const recovered = await this.recoverAcceptedTasks(channel)
                if (!data?.sync && recovered.length) log += await this.syncItems(channel, recovered)
                const filter: any = { tenantId: channel.tenantId, channels: { [channel.identifier]: { status: data?.sync ? { [Op.ne]: null } : 1 } } }
                if (data?.item) filter.id = data.item
                const items = await Item.findAll({ where: filter })
                if (data?.sync) log += await this.syncItems(channel, items)
                else log += await this.submitItems(channel, items, language)
                await this.finishExecution(channel, execution, 2, log)
            } catch (error: any) {
                logger.error('MVideo channel processing failed', error)
                await this.finishExecution(channel, execution, 3, log + '\n' + error.message)
            }
        } finally { this.running.delete(key) }
    }

    private async submitItems(channel: Channel, items: Item[], language: string): Promise<string> {
        const prepared: PreparedOffer[] = []
        const pending: Item[] = []
        const ids = new Set<string>()
        let log = ''
        for (const item of items) {
            const state = item.channels[channel.identifier]
            if (!state || state.status !== 1) continue
            if (state.taskCode && !state.mvideoTaskFinished) { pending.push(item); continue }
            try {
                if (state.productId || item.values[channel.config.mvideoIdAttr]) throw new Error('Карточка уже создана. API /v2/material поддерживает создание; повторная отправка заблокирована')
                const category = await this.findCategory(channel, item)
                const offer = await this.buildOffer(channel, item, category, language)
                if (ids.has(offer.offerId)) throw new Error('Повторяющийся offerId в выгрузке: ' + offer.offerId)
                ids.add(offer.offerId)
                prepared.push({ item, offer })
            } catch (error: any) {
                await this.saveState(channel, item, { status: 3, message: error.message })
                log += item.identifier + ': ' + error.message + '\n'
            }
        }
        if (pending.length) log += await this.syncItems(channel, pending)
        if (process.env.OPENPIM_MVIDEO_EMULATION === 'true') {
            const offerIds = prepared.map(entry => entry.offer.offerId)
            const msg = 'Включена эмуляция работы, заявка на создание не была отправлена в МВидео (' + offerIds.length + ' товаров: ' + offerIds.join(', ') + ')'
            logger.info(msg)
            return log + msg + '\n'
        }
        for (let offset = 0; offset < prepared.length; offset += 50) {
            const batch = prepared.slice(offset, offset + 50)
            let response: any
            try {
                response = await this.request(channel, 'POST', '/v2/material', { offerMappings: batch.map(entry => entry.offer) })
                if (!response.taskCode || typeof response.taskCode !== 'string') throw new Error('МВидео не вернул taskCode; проверьте заявку в кабинете перед повторной отправкой')
            } catch (error: any) {
                // Creation is not idempotent. Never retry automatically after an ambiguous network error.
                for (const entry of batch) await this.saveState(channel, entry.item, { status: 3, message: error.message + '. Перед повторной отправкой проверьте товар в кабинете МВидео' })
                throw error
            }
            // Journal the accepted batch before individual item writes so a partial DB failure can resume.
            channel.runtime.mvideoAcceptedTasks = [...(channel.runtime.mvideoAcceptedTasks || []), {
                taskCode: response.taskCode,
                offers: batch.map(entry => ({ itemId: entry.item.id, offerId: entry.offer.offerId, category: String(entry.offer.categoryId) })),
            }]
            channel.changed('runtime', true)
            try { await channel.save() } catch (error: any) {
                logger.error('MVideo accepted task ' + response.taskCode + ' could not be journaled', error)
                throw new Error('Принята заявка МВидео ' + response.taskCode + ', не удалось сохранить её: ' + error.message)
            }
            // Save every accepted offer before requesting a task status or sending another batch.
            for (const entry of batch) {
                await this.saveState(channel, entry.item, {
                    status: 4, message: 'Заявка принята МВидео, ожидается обработка', taskCode: response.taskCode,
                    offerId: entry.offer.offerId, category: String(entry.offer.categoryId), mvideoTaskFinished: false,
                    mvideoStatus: 'NEW_MAPPING', submittedAt: Date.now(),
                })
            }
            channel.runtime.mvideoAcceptedTasks = channel.runtime.mvideoAcceptedTasks.filter((task: any) => task.taskCode !== response.taskCode)
            channel.changed('runtime', true)
            await channel.save()
            log += 'Заявка ' + response.taskCode + ': ' + batch.length + ' товаров\n'
        }
        return log
    }

    private async recoverAcceptedTasks(channel: Channel): Promise<Item[]> {
        const tasks = channel.runtime.mvideoAcceptedTasks || []
        const recovered: Item[] = []
        for (const task of tasks) {
            for (const offer of task.offers) {
                const item = await Item.findOne({ where: { id: offer.itemId, tenantId: channel.tenantId } })
                if (!item) continue
                const state = item.channels[channel.identifier]
                if (state?.taskCode === task.taskCode && state.mvideoTaskFinished) continue
                if (state?.taskCode !== task.taskCode) {
                    const pending = { status: 4, message: 'Восстановлена принятая заявка МВидео', taskCode: task.taskCode,
                        offerId: offer.offerId, category: offer.category, mvideoTaskFinished: false }
                    await this.saveState(channel, item, pending)
                    item.channels[channel.identifier] = { ...state, ...pending }
                }
                recovered.push(item)
            }
        }
        if (tasks.length) {
            channel.runtime.mvideoAcceptedTasks = []
            channel.changed('runtime', true)
            await channel.save()
        }
        return recovered
    }

    private async syncItems(channel: Channel, items: Item[]): Promise<string> {
        const tasks = new Map<string, Item[]>()
        for (const item of items) {
            const state = item.channels[channel.identifier]
            if (!state?.taskCode || state.mvideoTaskFinished) continue
            const group = tasks.get(state.taskCode) || []
            group.push(item)
            tasks.set(state.taskCode, group)
        }
        let log = ''
        for (const [taskCode, group] of tasks) {
            const response = await this.request(channel, 'GET', '/v2/material/' + encodeURIComponent(taskCode) + '/status')
            const offers = response.offers || []
            if (!Array.isArray(offers)) throw new Error('МВидео вернул некорректный статус заявки')
            for (const item of group) {
                const existing = item.channels[channel.identifier]
                const offer = offers.find((value: any) => value.offerId === existing.offerId)
                const state: any = { taskCode, mvideoTaskStatus: response.taskStatus, syncedAt: Date.now() }
                const values: any = {}
                if (offer?.status === 'SUCCEEDED' && offer.productId) {
                    Object.assign(state, { status: 2, message: '', productId: String(offer.productId), mvideoStatus: offer.status, mvideoTaskFinished: true, mvideoErrors: [] })
                    values[channel.config.mvideoIdAttr] = String(offer.productId)
                } else if (offer?.status?.startsWith('FAILED') || FINAL_TASKS.includes(response.taskStatus)) {
                    const errors = offer?.errors || []
                    const message = errors.map((err: any) => [err.attribute, err.errorDescription].filter(Boolean).join(': ')).join('; ')
                    Object.assign(state, { status: 3, message: message || 'Заявка завершена без успешного создания товара: ' + (offer?.status || response.taskStatus),
                        mvideoStatus: offer?.status || response.taskStatus, mvideoTaskFinished: true, mvideoErrors: errors })
                } else {
                    Object.assign(state, { status: 4, message: 'МВидео обрабатывает заявку: ' + (offer?.status || response.taskStatus || 'NEW'), mvideoStatus: offer?.status || 'NEW_MAPPING', mvideoTaskFinished: false })
                }
                await this.saveState(channel, item, state, values)
                log += item.identifier + ': ' + state.mvideoStatus + '\n'
            }
        }
        return log
    }
}
