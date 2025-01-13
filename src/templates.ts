import Context from './context'
import { Request, Response } from 'express'
import logger from './logger'
import { Item } from './models/items'
import { Template } from './models/templates'
import { LOV } from './models/lovs'
import hbs from 'handlebars'
import { ChannelCategory, ChannelHandler } from './channels/ChannelHandler'
import { Channel } from './models/channels'
import promisedHandlebars from 'promised-handlebars'
import Q from 'q'
import helpers from 'handlebars-helpers'
import { replaceOperations } from './resolvers/utils'

const handlebarsHelpers = helpers()

const Handlebars = promisedHandlebars(hbs, { Promise: Q.Promise })

class templateHandler extends ChannelHandler {
    processChannel(channel: Channel, language: string, data: any, context?: Context): Promise<void> {
        return Promise.resolve()
    }
    getCategories(channel: Channel): Promise<{ list: ChannelCategory[] | null; tree: ChannelCategory | null }> {
        return Promise.resolve({ list: null, tree: null })
    }
    getAttributes(channel: Channel, categoryId: string): Promise<{ id: string; name: string; required: boolean; dictionary: boolean; dictionaryLink?: string }[]> {
        return Promise.resolve([])
    }
}

const handler = new templateHandler()

export async function generateTemplate(context: Context, request: Request, response: Response) {
    try {
        const templateId = parseInt(request.params.template_id)
        const itemId = parseInt(request.params.id)

        if (isNaN(templateId) || isNaN(itemId)) {
            logger.error('Invalid template or item ID')
            return response.status(400).send('Invalid template or item ID')
        }

        const template = await Template.findByPk(templateId)
        if (!template) {
            logger.error(`Template not found: ${templateId}`)
            return response.status(404).send('Template not found')
        }
        const skipAuth = template.options.some((elem: any) => elem.name === 'directUrl' && elem.value === 'true')
        if (!skipAuth) {
            context.checkAuth()
        }

        const item = await Item.findByPk(itemId)
        if (!item) {
            logger.error(`Item not found: ${itemId}`)
            return response.status(404).send('Item not found')
        }

        Object.keys(handlebarsHelpers).forEach(helperName => {
            Handlebars.registerHelper(helperName, handlebarsHelpers[helperName])
        })

        Handlebars.registerHelper('LOVvalue', async function (args: any) {
            const { identifier, valueId, language, lovCache = {} } = args.hash

            if (identifier in lovCache) {
                return lovCache[identifier].find((lov: any) => lov.id === valueId)?.value?.[language] || ''
            }

            const result = await LOV.findOne({ where: { identifier } })
            if (result) {
                lovCache[identifier] = result.values
                return lovCache[identifier].find((lov: any) => lov.id === valueId)?.value?.[language] || ''
            }

            return ''
        })

        Handlebars.registerHelper('evaluateExpression', async function (args: any) {
            const { expr } = args.hash
            const value = await handler.evaluateExpressionCommon(item.get().tenantId, item.get(), expr, null, null)
            return value
        })

        const compiledTemplate = Handlebars.compile(template.template)
        const html = await compiledTemplate({
            item: item.get(),
            context: {
                lovCache: {}
            }})

        response.setHeader('Content-Type', 'text/html')
        response.status(200).send(html)
        return
    } catch (error) {
        logger.error('Error generating template', error)
        response.status(500).send('Internal Server Error')
        return
    }
}

export async function generateTemplateForItems(context: Context, request: Request, response: Response) {
    try {
        const { where, templateId, itemId } = request.body

        if (isNaN(templateId)) {
            logger.error('Invalid template ID')
            return response.status(400).send('Invalid template ID')
        }

        const template = await Template.findByPk(templateId)
        if (!template) {
            logger.error(`Template not found: ${templateId}`)
            return response.status(404).send('Template not found')
        }

        if (isNaN(templateId)) {
            logger.error('Invalid template ID')
            return response.status(400).send('Invalid template ID')
        }

        let parentItem = null
        if (itemId) {
            parentItem = await Item.findByPk(itemId)
            if (!parentItem) {
                logger.error(`Parent item not found: ${itemId}`)
                return response.status(404).send('Parent item not found')
            }
        }

        const skipAuth = template.options.some((elem: any) => elem.name === 'directUrl' && elem.value === 'true')
        if (!skipAuth) {
            context.checkAuth()
        }

        let whereObj = JSON.parse(where)
        const include = replaceOperations(whereObj, context)
        let search: any = { where: whereObj }
        if (include && include.length > 0) {
            search.include = include
        }
        const items = await Item.findAll(search)

        if (!items || items.length === 0) {
            logger.error(`Items not found with conditions: ${JSON.stringify(where)}`)
            return response.status(404).send('No items found matching the conditions')
        }

        Object.keys(handlebarsHelpers).forEach(helperName => {
            Handlebars.registerHelper(helperName, handlebarsHelpers[helperName])
        })

        Handlebars.registerHelper('LOVvalue', async function (args: any) {
            const { identifier, valueId, language, lovCache = {} } = args.hash

            if (identifier in lovCache) {
                return lovCache[identifier].find((lov: any) => lov.id === valueId)?.value?.[language] || ''
            }

            const result = await LOV.findOne({ where: { identifier } })
            if (result) {
                lovCache[identifier] = result.values
                return lovCache[identifier].find((lov: any) => lov.id === valueId)?.value?.[language] || ''
            }

            return ''
        })

        Handlebars.registerHelper('evaluateExpression', async function (args: any) {
            const { expr } = args.hash
            const value = await handler.evaluateExpressionCommon(items[0].get().tenantId, items[0].get(), expr, null, null)
            return value
        })

        const compiledTemplate = Handlebars.compile(template.template)
        const html = await compiledTemplate({
            items: items.map(item => item.get()),
            parentItem: parentItem,
            context: {
                lovCache: {}
            }
        })

        response.setHeader('Content-Type', 'text/html')
        response.status(200).send(html)
        return
    } catch (error) {
        logger.error('Error generating template', error)
        response.status(500).send('Internal Server Error')
        return
    }
}
