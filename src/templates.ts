import Context from './context'
import { Request, Response } from 'express'
import logger from './logger'
import { Item } from './models/items'
import { Template } from './models/templates'
import { LOV } from './models/lovs'
import promisedHandlebars from 'promised-handlebars'
import Q from 'q'
import hbs from 'handlebars'
import { ChannelHandler } from './channels/ChannelHandler'

const Handlebars = promisedHandlebars(hbs, { Promise: Q.Promise })

class MyChannelHandler extends ChannelHandler {}

const handler = new MyChannelHandler()

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

        const item = await Item.findByPk(itemId)
        if (!item) {
            logger.error(`Item not found: ${itemId}`)
            return response.status(404).send('Item not found')
        }

        Handlebars.registerHelper('LOVvalue', async function (args: any) {
            const { identifier, valueId, language, context } = args.hash
            const lovCache = context.lovCache || {}

            if (identifier in lovCache) {
                return lovCache[identifier].find((lov: any) => lov.id === valueId)?.value?.[language] || ''
            }

            const result = await LOV.findOne({ where: { identifier } })
            if (result) {
                lovCache[identifier] = result.values
                context.lovCache = lovCache
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
