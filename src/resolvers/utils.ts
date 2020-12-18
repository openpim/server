import XRegExp = require("xregexp")
import { ModelManager, ModelsManager } from "../models/manager"
import { Item } from "../models/items"
import { EventType, TriggerType, Action } from "../models/actions"
import {VM, VMScript} from 'vm2'
import Context from "../context"
import { ItemRelation } from "../models/itemRelations"
const { Op } = require("sequelize");

import logger from '../logger'

export function filterValues(allowedAttributes: string[] | null, values:any) {
    if (allowedAttributes) {
        for (const prop in values) {
            if (!allowedAttributes.includes(prop)) {
                delete values[prop]
            }
        }
    }    
}

export function mergeValues(newValues: any, oldValues: any): any {
    if (newValues) {
        if (oldValues) {
            for (const prop in oldValues) {
                const obj = oldValues[prop]
                if (obj !== null && typeof obj === 'object') {
                    newValues[prop] = {...oldValues[prop], ...newValues[prop]}
                }
            }
            return {...oldValues, ...newValues}
        } else {
            return newValues
        }
    } else {
        return oldValues
    }
}

export function checkValues(mng: ModelManager, values: any) {
    for(const prop in values) {
        const attr = mng.getAttributeByIdentifier(prop)?.attr
        if (attr && attr.pattern) {
            const regex = XRegExp(attr.pattern, 'g')
            if (attr.languageDependent) {
                for(const lang in values[prop]) {
                    const value = '' + values[prop][lang]
                    if (!regex.test(value)) throw new Error(attr.errorMessage || 'Wrong value: ' + value + ' for pattern: ' + attr.pattern)    
                }
            } else {
                const value = '' + values[prop]
                if (!regex.test(value)) throw new Error(attr.errorMessage || 'Wrong value: ' + value + ' for pattern: ' + attr.pattern)
            }
        }
    }
}

export async function processItemActions(context: Context, event: EventType, item: Item, newValues: any, isImport: boolean) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const pathArr = item.path.split('.').map((elem:string) => parseInt(elem))
    const actions = mng.getActions().filter(action => {
        for (let i = 0; i < action.triggers.length; i++) {
            const trigger = action.triggers[i]

            const result = parseInt(trigger.type) === TriggerType.Item && 
                parseInt(trigger.event) === event && 
                item.typeId === parseInt(trigger.itemType) &&
                pathArr.includes(parseInt(trigger.itemFrom))
            if (result) return true
        }
        return false
    })
    await processActions(mng, actions, { Op: Op,
        isImport: isImport, 
        item: makeItemProxy(item), values: newValues, 
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
        } 
    })
}

export async function processItemButtonActions(context: Context, buttonText: string, item: Item) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const pathArr = item.path.split('.').map((elem:string) => parseInt(elem))
    const actions = mng.getActions().filter(action => {
        for (let i = 0; i < action.triggers.length; i++) {
            const trigger = action.triggers[i]

            const result = parseInt(trigger.type) === TriggerType.Button && 
                trigger.itemButton === buttonText && 
                item.typeId === parseInt(trigger.itemType) &&
                pathArr.includes(parseInt(trigger.itemFrom))
            if (result) return true
        }
        return false
    })
    const values = {...item.values}
    await processActions(mng, actions, { Op: Op,
        buttonText: buttonText, 
        item: makeItemProxy(item), values: values, 
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
        } 
    })
    return values
}

export async function testAction(context: Context, action: Action, item: Item) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const values = {...item.values}
    let log = ''
    const compileError = await processActionsWithLog(mng, [action], { Op: Op, 
        item: makeItemProxy(item), values: values, 
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
        }},
        { 
            log: ((...args: any) => { log += '' + args + '\n'}),
            error: ((...args: any) => { log += '[ERROR] ' + args + '\n'}),
        },
        true
    )
    return { values, log, compileError }
}

async function processActions(mng: ModelManager, actions: Action[], sandbox: any) {
    const cons = { 
        log: ((...args: any) => {logger.info('VM: ', args)}),
        error: ((...args: any) => {logger.error('VM: ', args)})
    }
    await processActionsWithLog(mng, actions, sandbox, cons , false)
}

async function processActionsWithLog(mng: ModelManager, actions: Action[], sandbox: any, console: any, returnCompileError: boolean) {
        if (actions.length > 0) {
        const vm = new VM({
            timeout: 3000,
            sandbox: sandbox
        }) 
        vm.setGlobals({console: console})

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i]
            let script:VMScript | string = mng.getActionsCache()[action.identifier]
            if (script !== 'compile_error') {
                if (!script) {
                    const code = `
                    async () => {
                        ` + action.code + `
                    }
                    `
                    script = new VMScript(code)
                    try {
                        script.compile()
                    } catch (err) {
                        if (returnCompileError) return err.message
                        logger.error('Failed to compile script.', err);
                        script = 'compile_error'
                    }
                    mng.getActionsCache()[action.identifier] = script
                }
                if (script !== 'compile_error') {
                    const funct = vm.run(<VMScript>script)
                    await funct()
                }
            }
        }
    }    
}

function makeModelProxy(model: any, itemProxy: any) {
    return new Proxy( model, {
        get: function( target, property, receiver ) {
            if ((<string>property) =='findOne') {
                return async(...args: any) => {
                    return itemProxy(await target[ property ].apply( target, args ))
                }
            } else if ((<string>property) =='create') {
                return async(...args: any) => {
                    return itemProxy(await target[ property ].apply( target, args ))
                }
            } else if ((<string>property) =='findAll') {
                return async(...args: any) => {
                    const arr = await target[ property ].apply( target, args )
                    return arr.map((elem: any) => itemProxy(elem))
                }
            }
        }
    })    
}

function makeItemProxy(item: any) {
    return new Proxy( item, {
        get: function( target, property, receiver ) {
            if ((<string>property) =='save') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='destroy') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='id') { return target[ property ]
            } else  if ((<string>property) =='tenantId') { return target[ property ]
            } else  if ((<string>property) =='identifier') { return target[ property ]
            } else  if ((<string>property) =='path') { return target[ property ]
            } else  if ((<string>property) =='typeId') { return target[ property ]
            } else  if ((<string>property) =='typeIdentifier') { return target[ property ]
            } else  if ((<string>property) =='parentIdentifier') { return target[ property ]
            } else  if ((<string>property) =='name') { return target[ property ]
            } else  if ((<string>property) =='values') { return target[ property ]
            } else  if ((<string>property) =='fileOrigName') { return target[ property ]
            } else  if ((<string>property) =='storagePath') { return target[ property ]
            } else  if ((<string>property) =='mimeType') { return target[ property ]
            } else  if ((<string>property) =='createdBy') { return target[ property ]
            } else  if ((<string>property) =='updatedBy') { return target[ property ]
            } else  if ((<string>property) =='createdAt') { return target[ property ]
            } else  if ((<string>property) =='updatedAt') { return target[ property ]
            }
        }
    })    
}
export async function processItemRelationActions(context: Context, event: EventType, itemRelation: ItemRelation, newValues: any, isImport: boolean) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const actions = mng.getActions().filter(action => {
        for (let i = 0; i < action.triggers.length; i++) {
            const trigger = action.triggers[i]

            const result = parseInt(trigger.type) === TriggerType.ItemRelation && 
                parseInt(trigger.event) === event && 
                itemRelation.relationId === parseInt(trigger.relation)
            if (result) return true
        }
        return false
    })
    await processActions(mng, actions, { Op: Op,
        isImport: isImport, 
        itemRelation: makeItemRelationProxy(itemRelation), values: newValues, 
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
        } 
    })
}

function makeItemRelationProxy(item: any) {
    return new Proxy( item, {
        get: function( target, property, receiver ) {
            if ((<string>property) =='save') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='destroy') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='id') { return target[ property ]
            } else  if ((<string>property) =='tenantId') { return target[ property ]
            } else  if ((<string>property) =='identifier') { return target[ property ]
            } else  if ((<string>property) =='relationId') { return target[ property ]
            } else  if ((<string>property) =='relationIdentifier') { return target[ property ]
            } else  if ((<string>property) =='itemId') { return target[ property ]
            } else  if ((<string>property) =='itemIdentifier') { return target[ property ]
            } else  if ((<string>property) =='targetId') { return target[ property ]
            } else  if ((<string>property) =='targetIdentifier') { return target[ property ]
            } else  if ((<string>property) =='values') { return target[ property ]
            } else  if ((<string>property) =='createdBy') { return target[ property ]
            } else  if ((<string>property) =='updatedBy') { return target[ property ]
            } else  if ((<string>property) =='createdAt') { return target[ property ]
            } else  if ((<string>property) =='updatedAt') { return target[ property ]
            }
        }
    })    
}
