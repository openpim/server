import Context from './context'
import { Request, Response } from 'express'
import logger from './logger'
import { Item } from './models/items'
import { Template } from './models/templates'
import { LOV } from './models/lovs'
import { Attribute } from './models/attributes'
import { ItemRelation } from './models/itemRelations'
import hbs from 'handlebars'
import { ChannelCategory, ChannelHandler } from './channels/ChannelHandler'
import { Channel } from './models/channels'
import promisedHandlebars from 'promised-handlebars'
import Q from 'q'
import helpers from 'handlebars-helpers'
import { replaceOperations } from './resolvers/utils'
import { Op } from 'sequelize'
import { JSDOM } from "jsdom"

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

        if (template?.templateRichtext != null && template.templateRichtext.trim() !== '') {
            const regex = /<attr\s+([^>]*)>\s*([\s\S]*?)\s*<\/attr>/g
            const matches = []
            let match

            while ((match = regex.exec(template.templateRichtext.trim())) !== null) {
                const attrString = match[1]
                const rawValue = match[2].trim()
                const value = rawValue.replace(/<[^>]+>/g, "")

                const attributes: { [key: string]: string } = {
                    identifier: "",
                    language: "",
                    relidentifier: "",
                    order: "",
                    mapping: "",
                    value,
                    rawValue
                }

                attrString.replace(/(\w+)="([^"]*)"/g, (_, key, val) => {
                    attributes[key as keyof typeof attributes] = val
                    return ""
                })

                matches.push(attributes)
            }

            const attributes = await Attribute.findAll({
                where: {
                    identifier: {
                        [Op.in]: matches.map((match) => match.identifier)
                    }
                }
            })

            const lovsIds = attributes
                .filter((attr) => attr.type === 7)
                .map((attr) => attr.lov)

            const lovs = await LOV.findAll({
                where: {
                    id: {
                        [Op.in]: lovsIds
                    },
                }
            })

            const lovsMap: Record<number, any> = {}
            lovs.forEach((lov) => {
                lovsMap[lov.id] = lov.values
            })

            const updatedRichtext = async () => {
                const matches = [...template.templateRichtext.matchAll(regex)]

                const replacements = matches.map(async ([match, attrString, value]) => {
                    const attrData: { [key: string]: string } = {}

                    attrString.replace(/(\w+)="([^"]*)"/g, (_, key, val) => {
                        attrData[key] = val
                        return ""
                    })

                    const attr = attrData.identifier || ""
                    const language = attrData.language || ""
                    const relIdentifier = attrData.relidentifier || ""
                    const order = attrData.order || ""
                    let mapping = attrData.mapping || ""
                    if (mapping) {
                        mapping = mapping.replace(/&quot;/g, '"')
                    }
                    if (relIdentifier) {
                        const itemRel = await ItemRelation.findOne({
                            where: {
                                itemId: itemId,
                                relationIdentifier: relIdentifier,
                                [Op.or]: [
                                    { values: { _itemRelationOrder: order } },
                                    { values: { _itemRelationOrder: { [Op.is]: null } } }
                                ]
                            }
                        })

                        return itemRel && itemRel.targetId != null
                            ? value.replace(/(src=['"][^'"]*\/asset\/inline\/)(\d+)(['"])/, `$1${itemRel?.targetId}$3`)
                            : '';

                    } else {
                        let replacement = item.values[attr] || ""

                        const attribute = attributes.find(attribute => attribute.identifier === attr)
                        if (attribute && attribute.type === 7) {
                            replacement = lovsMap[attribute.lov]?.find((el: { id: number }) => el.id == replacement)?.value?.[language] || replacement
                        }

                        if (mapping) {
                            for (const { before, after } of JSON.parse(mapping)) {
                                if (replacement === before) {
                                    replacement = after
                                    break
                                }
                            }
                        }

                        const replaceInnerText = (htmlString: string, newText: string): string => {
                            const dom = new JSDOM(htmlString)
                            const doc = dom.window.document.body

                            const replaceTextNodes = (node: ChildNode) => {
                                node.childNodes.forEach((child: any) => {
                                    if (child.nodeType === doc.TEXT_NODE) {
                                        child.nodeValue = newText
                                    } else {
                                        replaceTextNodes(child)
                                    }
                                })
                            }

                            replaceTextNodes(doc)
                            return doc.innerHTML
                        }

                        return replaceInnerText(value, replacement)
                    }
                })

                const replacedValues = await Promise.all(replacements)

                let index = 0
                return template.templateRichtext.replace(regex, () => replacedValues[index++])
            }

            let updatedRichtextResult = await updatedRichtext()

            const generateFontFaceCSS = (htmlContent: string) => {
                const fontRegex = /font-family:\s*['"]?([\w\s-]+)['"]?/gi
                const foundFonts = new Set<string>()

                htmlContent.replace(fontRegex, (_, font) => {
                    if (!font.toLowerCase().includes("sans-serif") && !font.toLowerCase().includes("arial")) {
                        foundFonts.add(font.trim())
                    }
                    return ''
                })

                const fontFaceCSS = Array.from(foundFonts).map(font => `
                    @font-face {
                        font-family: '${font}';
                        src: url('/static/fonts/${font}.woff2') format('woff2'),
                             url('/static/fonts/${font}.woff') format('woff'),
                             url('/static/fonts/${font}.ttf') format('truetype'),
                             url('/static/fonts/${font}.otf') format('opentype');
                        font-weight: normal;
                        font-style: normal;
                    }`).join('\n')
                return `<style>
                ${fontFaceCSS}
                body {
                    margin: 0
                }
                </style>`
            }

            const fontStyles = generateFontFaceCSS(updatedRichtextResult)
            updatedRichtextResult = updatedRichtextResult + '\n' + fontStyles

            response.setHeader("Content-Type", "text/html")
            response.status(200).send(updatedRichtextResult)
            return
        } else {
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
                }
            })

            response.setHeader('Content-Type', 'text/html')
            response.status(200).send(html)
            return
        }
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
