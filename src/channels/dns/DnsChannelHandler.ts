import { Channel } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from '../../logger'
import { sequelize } from '../../models'
import { Op } from 'sequelize'
import { ItemRelation } from '../../models/itemRelations'
import Context from '../../context'
import { processItemActions } from '../../resolvers/utils'
import { EventType } from '../../models/actions'

const DNS_API = 'https://seller.dns-shop.ru/api/v1beta1'

const CLASS_PREFIX = 'dnsclass_'
const SPEC_MARKER = '_spec_'
const OPTION_PREFIX = 'dnsattr_'
const BRAND_ATTR_ID = 'dnsbrand'
const COUNTRY_ATTR_ID = 'dnscountry'

interface JobContext {
    log: string
}

interface DnsResponse {
    status: number
    json: any
    text: string
    headers: any
}

interface StandardField {
    id: string
    field: string
    required: boolean
    kind: 'text' | 'int' | 'decimal' | 'money'
}

// Maps mapping-config attribute ids (#name) to DNS ProductCreateRequest fields.
const STANDARD_FIELDS: StandardField[] = [
    { id: '#name', field: 'name', required: true, kind: 'text' },
    { id: '#salePrice', field: 'salePrice', required: true, kind: 'money' },
    { id: '#mpn', field: 'mpn', required: true, kind: 'text' },
    { id: '#article', field: 'article', required: true, kind: 'text' },
    { id: '#manufacturerBarcode', field: 'manufacturerBarcode', required: true, kind: 'text' },
    { id: '#warrantyMonths', field: 'warrantyMonths', required: true, kind: 'int' },
    { id: '#packageLengthCm', field: 'packageLengthCm', required: true, kind: 'decimal' },
    { id: '#packageWidthCm', field: 'packageWidthCm', required: true, kind: 'decimal' },
    { id: '#packageHeightCm', field: 'packageHeightCm', required: true, kind: 'decimal' },
    { id: '#netWeightKg', field: 'netWeightKg', required: true, kind: 'decimal' },
    { id: '#tnvedCode', field: 'tnvedCode', required: true, kind: 'text' },
    { id: '#okpd2Code', field: 'okpd2Code', required: true, kind: 'text' },
    { id: '#mainPhotoUrl', field: 'mainPhotoUrl', required: true, kind: 'text' },
    { id: '#description', field: 'description', required: false, kind: 'text' },
    { id: '#shelfLifeMonths', field: 'shelfLifeMonths', required: false, kind: 'int' },
    { id: '#photoUrls', field: 'photoUrls', required: false, kind: 'text' },
    { id: '#richPhotoUrls', field: 'richPhotoUrls', required: false, kind: 'text' },
    { id: '#certificateNumber', field: 'certificateNumber', required: false, kind: 'text' },
    { id: '#certificateStartDate', field: 'certificateStartDate', required: false, kind: 'text' },
    { id: '#certificateEndDate', field: 'certificateEndDate', required: false, kind: 'text' },
    { id: '#certificateUrl', field: 'certificateUrl', required: false, kind: 'text' }
]

function classNodeId(classId: string): string {
    return CLASS_PREFIX + classId
}

function specNodeId(classId: string, specId: string): string {
    return CLASS_PREFIX + classId + SPEC_MARKER + specId
}

function parseCategoryId(id: string): { classId: string, specId: string } | null {
    if (!id || id.indexOf(CLASS_PREFIX) !== 0) return null
    const rest = id.substring(CLASS_PREFIX.length)
    const idx = rest.indexOf(SPEC_MARKER)
    if (idx === -1) return null
    const classId = rest.substring(0, idx)
    const specId = rest.substring(idx + SPEC_MARKER.length)
    if (!classId || !specId) return null
    return { classId, specId }
}

// returns the class id for a class node (dnsclass_<class>) or null for leaf/foreign nodes
function parseClassNodeId(id: string): string | null {
    if (!id || id.indexOf(CLASS_PREFIX) !== 0) return null
    const rest = id.substring(CLASS_PREFIX.length)
    if (rest.indexOf(SPEC_MARKER) !== -1) return null
    return rest || null
}

export class DnsChannelHandler extends ChannelHandler {
    // Channel type 10 is gated by the licence key (OPENPIM_KEY must list 10).
    private cache = new NodeCache({ useClones: false });
    private lastRequestAt = 0

    // ------------------------------------------------------------------
    // low level API helpers
    // ------------------------------------------------------------------

    private authHeaders(channel: Channel, extra?: any): any {
        const headers: any = {
            'Authorization': 'Bearer ' + (channel.config.dnsApiToken || ''),
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
        if (extra) Object.assign(headers, extra)
        return headers
    }

    private async dnsRequest(channel: Channel, context: JobContext | null, method: string, path: string, body?: any, extraHeaders?: any): Promise<DnsResponse> {
        const url = path.indexOf('http') === 0 ? path : DNS_API + path

        // global throttle: DNS rate limits per API key, keep requests spaced out
        const minInterval = parseInt(process.env.OPENPIM_DNS_REQUEST_DELAY || '250', 10)
        if (minInterval > 0) {
            const delta = Date.now() - this.lastRequestAt
            if (delta < minInterval) await this.sleep(minInterval - delta)
        }
        this.lastRequestAt = Date.now()

        const request: any = {
            method,
            headers: this.authHeaders(channel, extraHeaders)
        }
        if (body !== undefined) request.body = JSON.stringify(body)

        const log = 'DNS request: ' + method.toUpperCase() + ' ' + url + (body !== undefined ? ' => ' + JSON.stringify(body) : '')
        logger.info(log)
        if (context && channel.config.debug) context.log += log + '\n'

        const res = await fetch(url, request)
        const text = await res.text()
        let json: any = null
        try {
            json = text ? JSON.parse(text) : null
        } catch (e) {
            json = null
        }

        const respLog = 'DNS response status: ' + res.status + (text ? ', body: ' + text : '')
        logger.info(respLog)
        if (context && channel.config.debug) context.log += respLog + '\n'

        return { status: res.status, json, text, headers: res.headers }
    }

    // Retries throttled responses (429) and temporary server errors, honouring Retry-After.
    private async dnsRequestWithRetry(channel: Channel, context: JobContext | null, method: string, path: string, body?: any, extraHeaders?: any, maxRetries = 5): Promise<DnsResponse> {
        let attempt = 0
        for (;;) {
            const res = await this.dnsRequest(channel, context, method, path, body, extraHeaders)
            if (res.status !== 429 && res.status !== 503) return res
            if (attempt >= maxRetries) return res

            let waitMs = 0
            const ra = res.headers && res.headers.get ? res.headers.get('retry-after') : null
            if (ra) {
                const n = parseFloat(ra)
                if (!isNaN(n)) waitMs = Math.min(n * 1000, 60000)
            }
            if (!waitMs) waitMs = Math.min(1000 * Math.pow(2, attempt), 30000)

            const msg = 'DNS rate limited (HTTP ' + res.status + '), retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + waitMs + 'ms'
            logger.warn(msg)
            if (context && channel.config.debug) context.log += msg + '\n'
            await this.sleep(waitMs)
            attempt++
        }
    }

    private describeError(res: DnsResponse): string {
        if (res.json && (res.json.type || res.json.title)) {
            let msg = '' + (res.json.type || res.json.title)
            if (Array.isArray(res.json['invalid-params'])) {
                msg += ' [' + res.json['invalid-params'].map((p: any) => (p.name || '?') + ':' + (p.code || '?')).join(', ') + ']'
            }
            return msg
        }
        return 'HTTP ' + res.status + (res.text ? ': ' + res.text.substring(0, 500) : '')
    }

    private extractLocationId(headers: any): string {
        if (!headers) return ''
        const loc = headers.get ? headers.get('location') : headers['location']
        if (!loc) return ''
        const m = ('' + loc).match(/\/products\/([^/?#]+)/)
        return m ? m[1] : ''
    }

    // ------------------------------------------------------------------
    // categories / attributes / dictionaries
    // ------------------------------------------------------------------

    public async getCategories(channel: Channel): Promise<{ list: ChannelCategory[] | null, tree: ChannelCategory | null }> {
        if (!channel.config.dnsApiToken) throw new Error('Не введен API-ключ DNS в конфигурации канала.')
        logger.info('DNS getCategories: loading classes, token length=' + ('' + channel.config.dnsApiToken).length)

        let tree: ChannelCategory | undefined = this.cache.get('categories')
        if (!tree) {
            const classes: any[] = []
            let cursor: string | null = null
            do {
                const path: string = '/catalog/classes?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor as string) : '')
                const res: DnsResponse = await this.dnsRequestWithRetry(channel, null, 'get', path)
                if (res.status !== 200) throw new Error('Не удалось получить классы DNS: ' + this.describeError(res))
                const page: any = res.json || {}
                const items: any[] = Array.isArray(page.items) ? page.items : []
                for (const cls of items) classes.push(cls)
                cursor = page.nextCursor || null
            } while (cursor)
            logger.info('DNS getCategories: received ' + classes.length + ' classes (specs are loaded lazily on expand)')
            if (classes.length === 0) {
                throw new Error('DNS вернул пустой список классов. Проверьте права API-ключа (catalog.read) и наличие открытых классов в кабинете DNS.')
            }

            // classes are returned as lazy nodes: specs are requested on expand via getChannelSubCategories
            const children: any[] = classes.map((cls: any) => ({
                id: classNodeId(cls.mdmClassId),
                name: cls.name,
                children: [],
                lazy: true
            }))
            tree = { id: '', name: 'root', children }
            this.cache.set('categories', tree, 6 * 3600)
        }
        return { list: null, tree: tree ?? null }
    }

    // Called on expand of a class node: returns its spec nodes.
    public async getSubCategories(channel: Channel, nodeId: string): Promise<ChannelCategory[] | null> {
        if (!channel.config.dnsApiToken) throw new Error('Не введен API-ключ DNS в конфигурации канала.')
        const classId = parseClassNodeId(nodeId)
        if (!classId) return null // spec leaf or foreign id
        const specs = await this.loadSpecs(channel, classId)
        return specs.map((spec: any) => ({
            id: specNodeId(classId, spec.uniformSpecId),
            name: spec.title
        })) as ChannelCategory[]
    }

    private async loadSpecs(channel: Channel, classId: string): Promise<any[]> {
        let specs = this.cache.get('specs_' + classId) as any[] | undefined
        if (!specs) {
            const res: DnsResponse = await this.dnsRequestWithRetry(channel, null, 'get', '/catalog/classes/' + encodeURIComponent(classId) + '/specs')
            if (res.status !== 200) throw new Error('Не удалось получить спецификации класса DNS: ' + this.describeError(res))
            specs = (res.json && Array.isArray(res.json.items)) ? res.json.items : []
            this.cache.set('specs_' + classId, specs, 6 * 3600)
        }
        return specs || []
    }

    // Accepts either a spec node (dnsclass_<class>_spec_<spec>) or a class node (dnsclass_<class>).
    // A class node resolves to its only spec; with several specs the user must pick one.
    private async resolveSpecId(channel: Channel, categoryId: string): Promise<{ classId: string, specId: string }> {
        const parsed = parseCategoryId(categoryId)
        if (parsed) return parsed
        const classId = parseClassNodeId(categoryId)
        if (!classId) throw new Error('Некорректный идентификатор категории DNS: ' + categoryId)
        const specs = await this.loadSpecs(channel, classId)
        if (specs.length === 1) return { classId, specId: specs[0].uniformSpecId }
        throw new Error('Для категории выбрана группа классов без спецификации. Разверните класс и выберите спецификацию (доступно спецификаций: ' + specs.length + ').')
    }

    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        if (!channel.config.dnsApiToken) throw new Error('Не введен API-ключ DNS в конфигурации канала.')
        const parsed = await this.resolveSpecId(channel, categoryId)

        const cacheKey = 'attr_' + parsed.specId
        let data: any[] | undefined = this.cache.get(cacheKey) as any[] | undefined
        if (!data) {
            const res: DnsResponse = await this.dnsRequestWithRetry(channel, null, 'get', '/catalog/specs/' + encodeURIComponent(parsed.specId) + '/schema')
            if (res.status !== 200) throw new Error('Не удалось получить схему карточки DNS: ' + this.describeError(res))

            const schema: any = res.json || {}
            const options: any[] = Array.isArray(schema.options) ? schema.options : []
            const attrs: any[] = options.map((opt: any) => {
                const isNumber = opt.type === 'Number'
                const unit = opt.unit ? ', ' + opt.unit : ''
                const closed = opt.valueSet === 'Closed'
                return {
                    id: OPTION_PREFIX + opt.optionId,
                    name: opt.title + unit + ' (' + (isNumber ? 'Number' : 'Text') + ')',
                    required: !!opt.required,
                    dictionary: closed,
                    filtering: false,
                    isNumber,
                    multiValue: !!opt.multiValue,
                    category: categoryId,
                    description: opt.title + '\n id: ' + opt.optionId + ', spec: ' + parsed.specId,
                    dictionaryLink: closed ? DNS_API + '/catalog/specs/' + parsed.specId + '/options/' + opt.optionId + '/values' : null,
                    dictionaryLinkPost: closed ? { body: { spec: parsed.specId, option: opt.optionId } } : null
                }
            })

            attrs.push({
                id: BRAND_ATTR_ID,
                name: 'Бренд (mdmBrandId)',
                required: true,
                dictionary: true,
                filtering: false,
                isNumber: false,
                category: categoryId,
                description: 'Бренд товара. Значения загружаются из DNS по классу и спецификации.',
                dictionaryLink: DNS_API + '/catalog/specs/' + parsed.specId + '/brands',
                dictionaryLinkPost: { body: { spec: parsed.specId, class: parsed.classId, kind: 'brand' } }
            })

            attrs.push({
                id: COUNTRY_ATTR_ID,
                name: 'Страна происхождения (countryOfOrigin)',
                required: true,
                dictionary: true,
                filtering: false,
                isNumber: false,
                category: categoryId,
                description: 'Страна происхождения товара (ISO 3166-1 alpha-2).',
                dictionaryLink: DNS_API + '/catalog/countries',
                dictionaryLinkPost: { body: { kind: 'country' } }
            })

            data = attrs
            this.cache.set(cacheKey, data, 6 * 3600)
        }

        // categoryId embeds both class and spec, so always re-stamp it for the caller
        const attrList: any[] = data || []
        return attrList.map((attr: any) => ({ ...attr, category: categoryId })) as ChannelAttribute[]
    }

    public async getChannelAttributeValues(channel: Channel, categoryId: string, attributeId: string): Promise<any> {
        if (!channel.config.dnsApiToken) return {}
        let parsed: { classId: string, specId: string }
        try {
            parsed = await this.resolveSpecId(channel, categoryId)
        } catch (e) {
            return {}
        }

        if (attributeId === BRAND_ATTR_ID) {
            return await this.loadDictionary(
                channel,
                '/catalog/specs/' + encodeURIComponent(parsed.specId) + '/brands?mdmClassId=' + encodeURIComponent(parsed.classId) + '&limit=200',
                (item: any) => ({ id: item.mdmBrandId, value: item.title })
            )
        }
        if (attributeId === COUNTRY_ATTR_ID) {
            return await this.loadDictionary(
                channel,
                '/catalog/countries',
                (item: any) => ({ id: item.alpha2, value: item.title })
            )
        }
        if (attributeId.indexOf(OPTION_PREFIX) === 0) {
            const optionId = attributeId.substring(OPTION_PREFIX.length)
            return await this.loadDictionary(
                channel,
                '/catalog/specs/' + encodeURIComponent(parsed.specId) + '/options/' + encodeURIComponent(optionId) + '/values?limit=200',
                (item: any) => ({ id: item.value, value: item.value })
            )
        }
        return {}
    }

    private async loadDictionary(channel: Channel, path: string, map: (item: any) => any): Promise<any> {
        // DNS caps page size at 200; clamp defensively
        path = path.replace(/([?&]limit=)(\d+)/, (_m, prefix, n) => prefix + Math.min(parseInt(n, 10), 200))
        const cacheKey = 'dict_' + path
        const cached = this.cache.get(cacheKey)
        if (cached) return cached

        const values: any[] = []
        let cursor: string | null = null
        let pages = 0
        let hasNext = false
        const MAX_PAGES = 5 // up to ~1000 values; more -> has_next and the UI refuses to auto-build a LOV
        do {
            const sep: string = path.indexOf('?') === -1 ? '?' : '&'
            const full: string = path + (cursor ? sep + 'cursor=' + encodeURIComponent(cursor as string) : '')
            const res: DnsResponse = await this.dnsRequestWithRetry(channel, null, 'get', full)
            if (res.status !== 200) {
                logger.error('Failed to load DNS dictionary ' + full + ': ' + this.describeError(res))
                return { values: [], error: this.describeError(res) }
            }
            const json: any = res.json || {}
            const items: any[] = Array.isArray(json.items) ? json.items : []
            for (const item of items) values.push(map(item))
            cursor = json.nextCursor || null
            pages++
            if (cursor && pages >= MAX_PAGES) { hasNext = true; break }
        } while (cursor)
        const result = { values, has_next: hasNext }
        this.cache.set(cacheKey, result, 3600)
        return result
    }

    // ------------------------------------------------------------------
    // channel processing
    // ------------------------------------------------------------------

    public async processChannel(channel: Channel, language: string, data: any): Promise<void> {
        const chanExec = await this.createExecution(channel)
        const context: JobContext = { log: '' }

        if (!channel.config.dnsApiToken) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен API-ключ DNS в конфигурации канала')
            return
        }
        if (!channel.config.dnsIdAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут, где хранить идентификатор товара DNS')
            return
        }

        try {
            if (!data) {
                const query: any = {}
                query[channel.identifier] = { status: 1 }
                const items = await Item.findAndCountAll({ where: { tenantId: channel.tenantId, channels: query } })
                context.log += 'Запущена выгрузка на DNS\n'
                context.log += 'Найдено ' + items.count + ' записей для обработки \n\n'
                for (let i = 0; i < items.rows.length; i++) {
                    const item = items.rows[i]
                    await this.processItem(channel, item, language, context)
                    context.log += '\n\n'
                }
            } else if (data.sync) {
                await this.syncJob(channel, context, data)
            } else if (data.clearCache) {
                this.cache.flushAll()
                this.clearLOVCache()
                context.log += 'Кеш очищен'
            }
            await this.finishExecution(channel, chanExec, 2, context.log)
        } catch (err) {
            logger.error('Error on DNS channel processing', err)
            context.log += 'Ошибка запуска канала - ' + JSON.stringify(err)
            await this.finishExecution(channel, chanExec, 3, context.log)
        }
    }

    async processItem(channel: Channel, item: Item, language: string, context: JobContext) {
        context.log += 'Обрабатывается запись с идентификатором: ' + item.identifier + '\n'

        if (!item.channels[channel.identifier]) {
            context.log += 'У записи нет данных канала, обработка пропущена\n'
            return
        }

        for (const categoryId in channel.mappings) {
            const categoryConfig = channel.mappings[categoryId]
            if (!categoryConfig || categoryConfig.deleted) continue
            if (categoryConfig.valid && categoryConfig.valid.length > 0 && (
                (categoryConfig.visible && categoryConfig.visible.length > 0) || categoryConfig.categoryExpr || (categoryConfig.categoryAttr && categoryConfig.categoryAttrValue))) {
                const pathArr = item.path.split('.')
                const tstType = categoryConfig.valid.includes(item.typeId) || categoryConfig.valid.includes('' + item.typeId)
                if (tstType) {
                    let tst: any = null
                    if (categoryConfig.visible && categoryConfig.visible.length > 0) {
                        if (categoryConfig.visibleRelation) {
                            const sources = await Item.findAll({
                                where: { tenantId: channel.tenantId, '$sourceRelation.relationId$': categoryConfig.visibleRelation, '$sourceRelation.targetId$': item.id },
                                include: [{ model: ItemRelation, as: 'sourceRelation' }]
                            })
                            tst = sources.some((source: any) => {
                                const sourcePath = source.path.split('.')
                                const catId = source.identifier.replace('dnsclass_', '')
                                return catId == categoryConfig.id && categoryConfig.visible.find((elem: any) => sourcePath.includes('' + elem))
                            })
                        } else {
                            tst = categoryConfig.visible.find((elem: any) => pathArr.includes('' + elem))
                        }
                    } else if (categoryConfig.categoryExpr) {
                        tst = await this.evaluateExpression(channel, item, categoryConfig.categoryExpr)
                    } else {
                        tst = item.values[categoryConfig.categoryAttr] && item.values[categoryConfig.categoryAttr] == categoryConfig.categoryAttrValue
                    }
                    if (tst) {
                        try {
                            const changedValues = await this.processItemInCategory(channel, item, categoryConfig, language, context)
                            await this.saveItemIfChanged(channel, item, changedValues)
                        } catch (err) {
                            logger.error('Failed to process item with id: ' + item.id + ' for tenant: ' + item.tenantId, err)
                            const data = item.channels[channel.identifier]
                            data.status = 3
                            data.message = 'Ошибка обработки товара: ' + err
                            context.log += data.message
                            await this.saveItemIfChanged(channel, item)
                        }
                        return
                    }
                }
            }
        }

        const data = item.channels[channel.identifier]
        data.status = 3
        data.message = 'Этот объект не подходит ни под одну категорию из этого канала.'
        context.log += 'Запись с идентификатором: ' + item.identifier + ' не подходит ни под одну категорию из этого канала.\n'
        await this.saveItemIfChanged(channel, item)
    }

    async saveItemIfChanged(channel: Channel, item: Item, changedValues: any = {}, dnsId: string = '') {
        const reloadedItem = await Item.findByPk(item.id) // refresh item from DB (other channels can already change it)
        if (!reloadedItem) return
        let changed = false
        let valuesChanged = false
        const data = item.channels[channel.identifier]
        const newChannels: any = {}
        newChannels[channel.identifier] = JSON.parse(JSON.stringify(reloadedItem.channels[channel.identifier] || {}))
        const tmp = newChannels[channel.identifier]

        if (dnsId && !tmp.dnsId) {
            changed = true
            tmp.dnsId = dnsId
            tmp.url = 'https://www.dns-shop.ru/product/' + dnsId + '/'
        }
        if (tmp.status !== data.status || tmp.message !== data.message) {
            changed = true
            tmp.status = data.status
            tmp.message = data.message
            if (data.syncedAt) tmp.syncedAt = data.syncedAt
            if (typeof data.dnsError !== 'undefined') tmp.dnsError = data.dnsError
        }
        if (data.url && tmp.url !== data.url) {
            changed = true
            tmp.url = data.url
        }

        if (changedValues && Object.keys(changedValues).length > 0) {
            changed = true
            valuesChanged = true
        }
        if (changed) {
            const ctx = Context.createAs('admin', channel.tenantId)
            try {
                if (valuesChanged) {
                    await processItemActions(ctx, EventType.BeforeUpdate, reloadedItem, reloadedItem.parentIdentifier, reloadedItem.name, changedValues, newChannels, false, false, false, null, { updateFromDns: channel.identifier })
                    reloadedItem.values = { ...reloadedItem.values, ...changedValues }
                    reloadedItem.changed('values', true)
                }
            } catch (err: any) {
                tmp.status = 3
                tmp.message = 'Ошибка: ' + err.message
            }
            reloadedItem.channels = { ...reloadedItem.channels, ...newChannels }
            reloadedItem.changed('channels', true)

            await sequelize.transaction(async (t) => {
                await reloadedItem.save({ transaction: t })
            })
            if (valuesChanged) {
                await processItemActions(ctx, EventType.AfterUpdate, reloadedItem, reloadedItem.parentIdentifier, reloadedItem.name, reloadedItem.values, reloadedItem.channels, false, false, false, null, { updateFromDns: channel.identifier })
            }
        }
    }

    async processItemInCategory(channel: Channel, item: Item, categoryConfig: any, language: string, context: JobContext): Promise<any> {
        context.log += 'Найдена категория "' + categoryConfig.name + '" для записи с идентификатором: ' + item.identifier + '\n'

        const changedValues: any = {}
        let parsed: { classId: string, specId: string }
        try {
            parsed = await this.resolveSpecId(channel, categoryConfig.id)
        } catch (err: any) {
            const msg = err && err.message ? err.message : ('Некорректный идентификатор категории DNS: ' + categoryConfig.id)
            context.log += msg
            this.reportError(channel, item, msg)
            return changedValues
        }

        const data = item.channels[channel.identifier]
        data.category = categoryConfig.id

        const attrs: any[] = Array.isArray(categoryConfig.attributes) ? categoryConfig.attributes : []
        const product: any = {}

        // standard fields (#name, #salePrice, ...)
        for (const sf of STANDARD_FIELDS) {
            const cfg = attrs.find((a: any) => a.id === sf.id)
            let value = cfg ? await this.getValueByMapping(channel, cfg, item, language) : null
            if (value === null || value === undefined || value === '') {
                if (sf.required) {
                    const msg = 'Не введена конфигурация или нет данных для "' + sf.field + '" для категории: ' + categoryConfig.name
                    context.log += msg
                    this.reportError(channel, item, msg)
                    return changedValues
                }
                continue
            }
            if (sf.kind === 'int') {
                const n = parseInt('' + value, 10)
                if (isNaN(n)) {
                    const msg = 'Значение "' + value + '" для поля "' + sf.field + '" не является целым числом'
                    context.log += msg
                    this.reportError(channel, item, msg)
                    return changedValues
                }
                product[sf.field] = n
            } else if (sf.kind === 'money') {
                const n = Number(value)
                if (isNaN(n)) {
                    const msg = 'Значение "' + value + '" для поля "' + sf.field + '" не является числом'
                    context.log += msg
                    this.reportError(channel, item, msg)
                    return changedValues
                }
                product[sf.field] = n
            } else if (sf.kind === 'decimal') {
                product[sf.field] = '' + value
            } else if (sf.id === '#photoUrls' || sf.id === '#richPhotoUrls') {
                product[sf.field] = Array.isArray(value) ? value : [value]
            } else {
                product[sf.field] = value
            }
        }

        // brand -> mdmBrandId
        const brandCfg = attrs.find((a: any) => a.id === BRAND_ATTR_ID)
        const brandValue = brandCfg ? await this.getValueByMapping(channel, brandCfg, item, language) : null
        if (!brandValue) {
            const msg = 'Не введена конфигурация или нет данных для бренда (mdmBrandId) для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return changedValues
        }
        product.mdmBrandId = await this.resolveDictionaryId(channel, parsed, BRAND_ATTR_ID, brandValue)

        // country -> countryOfOrigin (ISO alpha-2)
        const countryCfg = attrs.find((a: any) => a.id === COUNTRY_ATTR_ID)
        const countryValue = countryCfg ? await this.getValueByMapping(channel, countryCfg, item, language) : null
        if (!countryValue) {
            const msg = 'Не введена конфигурация или нет данных для страны происхождения (countryOfOrigin) для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return changedValues
        }
        product.countryOfOrigin = await this.resolveDictionaryId(channel, parsed, COUNTRY_ATTR_ID, countryValue)

        // spec options
        const specAttrs = await this.getAttributes(channel, categoryConfig.id)
        const optionValues: Record<string, string> = {}
        for (const opt of specAttrs as any[]) {
            if (!opt.id || opt.id.indexOf(OPTION_PREFIX) !== 0) continue
            const cfg = attrs.find((a: any) => a.id === opt.id)
            if (!cfg) continue
            const value = await this.getValueByMapping(channel, cfg, item, language)
            if (value === null || value === undefined || value === '') continue

            const optionId = opt.id.substring(OPTION_PREFIX.length)
            const arr = Array.isArray(value) ? value : [value]
            const mapped: string[] = []
            for (const raw of arr) {
                let sv: any = (typeof raw === 'string' || raw instanceof String) ? ('' + raw).trim() : raw
                if (sv === '' || sv === null || sv === undefined) continue
                if (opt.dictionary) {
                    const resolved = await this.resolveOptionValue(channel, parsed, optionId, sv)
                    if (!resolved) {
                        const msg = 'Значение "' + sv + '" не найдено в справочнике DNS для атрибута "' + opt.name + '"'
                        context.log += msg
                        this.reportError(channel, item, msg)
                        return changedValues
                    }
                    sv = resolved
                }
                mapped.push('' + sv)
            }
            if (mapped.length > 0) {
                optionValues[optionId] = opt.multiValue ? mapped.join(', ') : mapped[0]
            }
        }

        product.mdmClassId = parsed.classId
        product.uniformSpecId = parsed.specId
        if (Object.keys(optionValues).length > 0) product.specOptionValues = optionValues

        const existingId = item.values[channel.config.dnsIdAttr] ? ('' + item.values[channel.config.dnsIdAttr]).trim() : ''

        if (process.env.OPENPIM_DNS_EMULATION === 'true') {
            const emulated = existingId
                ? { method: 'PUT', url: '/products/' + existingId + '/uniform', body: { specOptionValues: optionValues, media: this.buildMedia(product), mainPhotoUrl: product.mainPhotoUrl || '' } }
                : { method: 'POST', url: '/products', body: product }
            const msg = 'Включена эмуляция работы, сообщение не было послано в DNS: ' + JSON.stringify(emulated)
            context.log += msg + '\n'
            data.status = 4
            data.message = msg
            delete data.dnsError
            item.changed('channels', true)
            return changedValues
        }

        if (!existingId) {
            // create
            const res = await this.dnsRequest(channel, context, 'post', '/products', product)
            if (res.status !== 201) {
                const msg = 'Ошибка создания товара в DNS: ' + this.describeError(res)
                context.log += msg
                this.reportChannelError(channel, item, msg, true)
                return changedValues
            }
            const created = res.json || {}
            const dnsId = created.id || this.extractLocationId(res.headers)
            if (dnsId) {
                changedValues[channel.config.dnsIdAttr] = dnsId
                data.dnsId = dnsId
                data.url = 'https://www.dns-shop.ru/product/' + dnsId + '/'
            }
            data.status = 4
            data.message = JSON.stringify(created)
            delete data.dnsError
            item.changed('channels', true)
        } else {
            // update: PUT uniform fully replaces specOptionValues/media
            const uniformRes = await this.dnsRequestWithRetry(channel, context, 'get', '/products/' + encodeURIComponent(existingId) + '/uniform')
            if (uniformRes.status !== 200) {
                const msg = 'Ошибка получения текущей карточки DNS: ' + this.describeError(uniformRes)
                context.log += msg
                this.reportChannelError(channel, item, msg, true)
                return changedValues
            }
            const uniform = uniformRes.json || {}
            const replace: any = {
                specOptionValues: optionValues,
                media: this.buildMedia(product),
                mainPhotoUrl: product.mainPhotoUrl || ''
            }
            const putRes = await this.dnsRequest(
                channel,
                context,
                'put',
                '/products/' + encodeURIComponent(existingId) + '/uniform',
                replace,
                { 'If-Product-Uniform-Revision': uniform.editRevision || '' }
            )
            if (putRes.status !== 200) {
                const msg = 'Ошибка обновления карточки DNS: ' + this.describeError(putRes)
                context.log += msg
                this.reportChannelError(channel, item, msg, true)
                return changedValues
            }
            data.status = 4
            data.message = JSON.stringify(putRes.json || {})
            delete data.dnsError
            item.changed('channels', true)
        }

        return changedValues
    }

    private buildMedia(product: any): any[] {
        const media: any[] = []
        const add = (value: any, type: string) => {
            if (value === null || value === undefined || value === '') return
            const arr = Array.isArray(value) ? value : [value]
            for (const url of arr) {
                if (url === null || url === undefined || url === '') continue
                media.push({ type, url: '' + url })
            }
        }
        add(product.photoUrls, 'Photo')
        add(product.richPhotoUrls, 'RichPhoto')
        return media
    }

    private reportChannelError(channel: Channel, item: Item, message: string, fromDns: boolean) {
        const data = this.reportError(channel, item, message)
        if (fromDns) data.dnsError = true
        else delete data.dnsError
        item.changed('channels', true)
        return data
    }

    private async resolveDictionaryId(channel: Channel, parsed: { classId: string, specId: string }, attrId: string, value: any): Promise<any> {
        const dict = await this.getChannelAttributeValues(channel, specNodeId(parsed.classId, parsed.specId), attrId)
        const values = (dict && Array.isArray(dict.values)) ? dict.values : []
        const found = values.find((v: any) => v.id === value || v.value === value)
        return found ? found.id : value
    }

    private async resolveOptionValue(channel: Channel, parsed: { classId: string, specId: string }, optionId: string, value: any): Promise<any> {
        const dict = await this.getChannelAttributeValues(channel, specNodeId(parsed.classId, parsed.specId), OPTION_PREFIX + optionId)
        const values = (dict && Array.isArray(dict.values)) ? dict.values : []
        const found = values.find((v: any) => v.value === value || v.id === value)
        return found ? found.value : null
    }

    // ------------------------------------------------------------------
    // status sync
    // ------------------------------------------------------------------

    async syncJob(channel: Channel, context: JobContext, data: any) {
        context.log += 'Запущена синхронизация с DNS\n'
        let items: Item[] = []
        if (data.item) {
            const item = await Item.findByPk(data.item)
            if (item) items.push(item)
        } else {
            const query: any = {}
            query[channel.identifier] = { status: { [Op.ne]: null } }
            items = await Item.findAll({ where: { tenantId: channel.tenantId, channels: query } })
        }
        context.log += 'Найдено ' + items.length + ' записей для обработки \n\n'
        await this.syncItems(channel, items, context)
        context.log += 'Синхронизация закончена'
    }

    async syncItems(channel: Channel, items: Item[], context: JobContext) {
        for (const item of items) {
            const channelData = item.channels[channel.identifier]
            if (!channelData) continue

            const dnsId = item.values[channel.config.dnsIdAttr]
            if (!dnsId) {
                context.log += 'У товара ' + item.identifier + ' нет идентификатора DNS, синхронизация не будет проводиться\n'
                continue
            }
            if (channelData.status === 1) {
                context.log += 'Статус товара ' + item.identifier + ' в отправке, синхронизация не будет проводиться \n'
                continue
            }
            if (channelData.status === 3 && !channelData.dnsError) {
                context.log += 'Статус товара ' + item.identifier + ' ошибка, синхронизация не будет проводиться \n'
                continue
            }

            const res = await this.dnsRequestWithRetry(channel, context, 'get', '/products/' + encodeURIComponent('' + dnsId))
            if (res.status === 404) {
                channelData.status = 3
                channelData.message = 'Товар не найден в DNS (404)'
                channelData.dnsError = true
                item.changed('channels', true)
                context.log += 'Товар ' + item.identifier + ' не найден в DNS\n'
                await this.saveItemIfChanged(channel, item)
                continue
            }
            if (res.status !== 200) {
                context.log += 'Ошибка запроса статуса товара ' + item.identifier + ': ' + this.describeError(res) + '\n'
                continue
            }

            this.processProductStatus(item, res.json, channel, context)
            await this.saveItemIfChanged(channel, item)
            context.log += '  товар c идентификатором ' + item.identifier + ' синхронизирован\n'
        }
    }

    processProductStatus(item: Item, product: any, channel: Channel, context: JobContext) {
        const data = item.channels[channel.identifier]
        const stage = product && product.stage
        const sub = product && product.approvedSubStatus
        const errKind = product && product.errorKind

        if (product && product.id) data.dnsId = product.id
        if (data.dnsId) data.url = 'https://www.dns-shop.ru/product/' + data.dnsId + '/'

        if (stage === 'Approved' && (sub === 'Selling' || sub === 'Paused' || !sub)) {
            data.status = 2
            data.dnsError = false
        } else if (stage === 'Review' || sub === 'CreatingProduct' || sub === 'CreatingCard') {
            data.status = 4
            data.dnsError = false
        } else if (stage === 'Rejected' || stage === 'Error' || stage === 'Blocked' || errKind) {
            data.status = 3
            data.dnsError = true
        } else {
            context.log += 'Неизвестный статус товара в DNS: stage=' + stage + ', subStatus=' + sub + '\n'
        }

        data.message = JSON.stringify(product)
        data.syncedAt = new Date().getTime()
        item.changed('channels', true)
    }
}
