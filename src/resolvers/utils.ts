import XRegExp = require("xregexp")
import { ModelManager, ModelsManager } from "../models/manager"
import { Item } from "../models/items"
import { EventType, TriggerType, Action } from "../models/actions"
import {VM, VMScript} from 'vm2'
import Context from "../context"
import { ItemRelation } from "../models/itemRelations"
import { exec } from 'child_process'
const { Op } = require("sequelize");
import { sequelize } from '../models'
import { QueryTypes } from 'sequelize'
import audit, { ChangeType, ItemChanges, ItemRelationChanges } from '../audit'

const util = require('util');
const awaitExec = util.promisify(exec);

import fetch from 'node-fetch'
import { URLSearchParams } from 'url'
import * as mailer from 'nodemailer'

import logger from '../logger'
import { LOV } from "../models/lovs"
const dateFormat = require("dateformat")

export function filterChannels(context: Context, channels:any) {
    for (const prop in channels) {
        if (!context.canViewChannel(prop)) {
            delete channels[prop]
        }
    }
}

export function filterEditChannels(context: Context, channels:any) {
    if (!channels) return
    for (const prop in channels) {
        if (!context.canEditChannel(prop)) {
            delete channels[prop]
        }
    }
}

export function checkSubmit(context: Context, channels: any) {
    if (channels) {
        for (const prop in channels) {
            if (channels[prop].status === 1) {
                channels[prop].submittedAt = Date.now()
                channels[prop].submittedBy = context.getCurrentUser()?.login
                channels[prop].message = ''
            }
            if (channels[prop].status === 2) {
                channels[prop].syncedAt = Date.now()
            }
        }
    }
}

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
                const newobj = newValues[prop]
                if (obj !== null && typeof obj === 'object' && typeof newobj === 'object' && !Array.isArray(newobj)) {
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

/*!
 * Find the differences between two objects and push to a new object
 * @param  {Object} obj1 The original object
 * @param  {Object} obj2 The object to compare against it
 * @return {Object}      An object of differences between the two
 */
export function diff(obj1: any, obj2: any) {
    // Make sure an object to compare is provided
    if (!obj2 || Object.prototype.toString.call(obj2) !== '[object Object]') {
        return obj1;
    }

    //
    // Variables
    //
    var diffs: any = {added:{}, changed: {}, old:{}, deleted: {}};
    var key;

    //
    // Methods
    //
    /**
     * Compare two items and push non-matches to object
     * @param  {*}      item1 The first item
     * @param  {*}      item2 The second item
     * @param  {String} key   The key in our object
     */
    var compare = function (item1: any, item2: any, key: any) {
        // Get the object type
        var type1 = Object.prototype.toString.call(item1);
        var type2 = Object.prototype.toString.call(item2);

        // If type2 is undefined it has been removed
        if (type2 === '[object Undefined]') {
            diffs.deleted[key] = item1;
            return;
        }

        // If items are different types
        if (type1 !== type2) {
            diffs.changed[key] = item2;
            diffs.old[key] = item1;
            return;
        }

        // If an object, compare recursively
        if (type1 === '[object Object]') {
            var objDiff = diff(item1, item2);
            if (Object.keys(objDiff).length > 0) {
                if (Object.keys(objDiff.added).length > 0) diffs.added[key] = objDiff.added;
                if (Object.keys(objDiff.changed).length > 0) diffs.changed[key] = objDiff.changed;
                if (Object.keys(objDiff.old).length > 0) diffs.old[key] = objDiff.old;
                if (Object.keys(objDiff.deleted).length > 0) diffs.deleted[key] = objDiff.deleted;
            }
            return;
        }

        if (item1 !== item2) {
            diffs.changed[key] = item2;
            diffs.old[key] = item1;
        }
    };

    //
    // Compare our objects
    //
    // Loop through the first object
    for (key in obj1) {
        if (key in obj1) {
            compare(obj1[key], obj2[key], key);
        }
    }

    // Loop through the second object and find missing items
    for (key in obj2) {
        if (key in obj2) {
            if (!(key in obj1) && obj1[key] !== obj2[key]) {
                diffs.added[key] = obj2[key];
            }
        }
    }

    // Return the object of differences
    return diffs
}

export function isObjectEmpty(obj:any) {
    return Object.keys(obj).length === 0;
}

export function checkValues(mng: ModelManager, values: any) {
    for(const prop in values) {
        const attr = mng.getAttributeByIdentifier(prop)?.attr
        if (attr && attr.pattern) {
            const regex = XRegExp(attr.pattern, 'g')
            if (attr.languageDependent) {
                for(const lang in values[prop]) {
                    const value = values[prop][lang] ? '' + values[prop][lang] : ''
                    if (!regex.test(value)) throw new Error(attr.errorMessage || 'Wrong value: ' + value + ' for pattern: ' + attr.pattern)    
                }
            } else {
                const value = values[prop] ? '' + values[prop] : ''
                if (!regex.test(value)) throw new Error(attr.errorMessage || 'Wrong value: ' + value + ' for pattern: ' + attr.pattern)
            }
        }
    }
}

export async function processItemActions(context: Context, event: EventType, item: Item, newValues: any, newChannels:any, isImport: boolean) {
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
    return await processActions(mng, actions, { Op: Op,
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { exec, awaitExec, fetch, URLSearchParams, mailer },
        isImport: isImport, 
        item: makeItemProxy(item), values: newValues, channels: newChannels,
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy)
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
    const channels = {...item.channels}
    const ret = await processActions(mng, actions, { Op: Op,
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { exec, awaitExec, fetch, URLSearchParams, mailer },
        buttonText: buttonText, 
        item: makeItemProxy(item), values: values, channels:channels,
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy)
        } 
    })
    return {values:values, result: ret[0]}
}

export async function testAction(context: Context, action: Action, item: Item) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const values = {...item.values}
    const channels = {...item.channels}
    let log = ''
    const ret = await processActionsWithLog(mng, [action], { Op: Op, 
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { exec, awaitExec, fetch, URLSearchParams, mailer },
        item: makeItemProxy(item), values: values, channels:channels, 
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy)
        }},
        { 
            log: ((...args: any) => { log += '' + args + '\n'}),
            error: ((...args: any) => { log += '[ERROR] ' + args + '\n'}),
        }
    )
    return { values, log, ...ret[0] }
}

async function processActions(mng: ModelManager, actions: Action[], sandbox: any) {
    const cons = { 
        log: ((...args: any) => {logger.info('ACTION: ' + args)}),
        error: ((...args: any) => {logger.error('ACTION: ' + args)})
    }
    return await processActionsWithLog(mng, actions, sandbox, cons)
}

async function processActionsWithLog(mng: ModelManager, actions: Action[], sandbox: any, console: any): 
    Promise<{identifier: string, compileError?: string, message?: string, error?:string}[]> {
    const retArr = []
    if (actions.length > 0) {
        const vm = new VM({
            timeout: 3000,
            sandbox: sandbox
        }) 
        vm.setGlobals({console: console})

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i]
            let script:VMScript | {compileError: boolean, error: string} | undefined = mng.getActionsCache()[action.identifier]
            if (script instanceof VMScript || script === undefined) {
                if (script === undefined) {
                    const code = `
                    async () => {
                        ` + action.code + `
                    }
                    `
                    script = new VMScript(code)
                    try {
                        script.compile()
                    } catch (err) {
                        retArr.push({identifier: action.identifier, compileError: err.message})
                        logger.error('Failed to compile script.', err);
                        script = {compileError: true, error: err.message}
                    }
                    mng.getActionsCache()[action.identifier] = script
                }
                if (script instanceof VMScript) {
                    const funct = vm.run(<VMScript>script)
                    const ret = await funct()
                    if (ret) {
                        if (typeof ret === 'object') {
                            retArr.push({identifier: action.identifier, message: ret.message, error: ret.error, data: ret.data})
                        } else {
                            retArr.push({identifier: action.identifier, message: ''+ret})
                        }
                    } else {
                        retArr.push({identifier: action.identifier})
                    }
                } else {
                    retArr.push({identifier: action.identifier, compileError: script.error})
                }
            } else {
                retArr.push({identifier: action.identifier, compileError: script.error})
            }
        }
    }
    return retArr
}

function makeModelProxy(model: any, itemProxy: any) {
    return new Proxy( model, {
        get: function( target, property, receiver ) {
            if ((<string>property) =='findOne') {
                return async(...args: any) => {
                    const tst = await target[ property ].apply( target, args )
                    return tst? itemProxy(tst) : undefined
                }
            } else if ((<string>property) =='create') {
                return async(...args: any) => {
                    return itemProxy(await target[ property ].apply( target, args ))
                }
            } else if ((<string>property) =='count') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
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
                    target.set('identifier', target.identifier + "_d"+Date.now())
                    target.save()            
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='set') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='changed') {
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
        },
        set: function(target, prop, value, receiver) {
            if (
                prop === 'path' ||
                prop === 'typeId' ||
                prop === 'typeIdentifier' ||
                prop === 'parentIdentifier' ||
                prop === 'name' ||
                prop === 'values' ||
                prop === 'fileOrigName' ||
                prop === 'mimeType' ||
                prop === 'updatedBy'
                ) {
                target[prop] = value
                return true
            } else {
                return false
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
    return await processActions(mng, actions, { Op: Op,
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { exec, awaitExec, fetch, URLSearchParams, mailer },
        isImport: isImport, 
        itemRelation: makeItemRelationProxy(itemRelation), values: newValues, 
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy)
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
                    target.set('identifier', target.identifier + "_d"+Date.now())
                    target.save()            
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='set') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='changed') {
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
        },
        set: function(target, prop, value, receiver) {
            if (
                prop === 'relationId' ||
                prop === 'relationIdentifier' ||
                prop === 'itemId' ||
                prop === 'itemIdentifier' ||
                prop === 'targetId' ||
                prop === 'targetIdentifier' ||
                prop === 'values' ||
                prop === 'updatedBy'
                ) {
                target[prop] = value
                return true
            } else {
                return false
            }
        }
    })
}

function makeLOVProxy(item: any) {
    return new Proxy(item, {
        get: function (target, property, receiver) {
            if ((<string>property) == 'save') {
                return async (...args: any) => {
                    return await target[property].apply(target, args)
                }
            } else if ((<string>property) == 'destroy') {
                return async (...args: any) => {
                    target.set('identifier', target.identifier + "_d" + Date.now())
                    target.save()
                    return await target[property].apply(target, args)
                }
            } else if ((<string>property) == 'set') {
                return async (...args: any) => {
                    return await target[property].apply(target, args)
                }
            } else  if ((<string>property) =='changed') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else if ((<string>property) == 'id') {
                return target[property]
            } else if ((<string>property) == 'tenantId') {
                return target[property]
            } else if ((<string>property) == 'identifier') {
                return target[property]
            } else if ((<string>property) == 'name') {
                return target[property]
            } else if ((<string>property) == 'values') {
                return target[property]
            } else if ((<string>property) == 'createdBy') {
                return target[property]
            } else if ((<string>property) == 'updatedBy') {
                return target[property]
            } else if ((<string>property) == 'createdAt') {
                return target[property]
            } else if ((<string>property) == 'updatedAt') {
                return target[property]
            }
        },
        set: function (target, prop, value, receiver) {
            if (
                prop === 'name' ||
                prop === 'values' ||
                prop === 'updatedBy'
            ) {
                target[prop] = value
                return true
            } else {
                return false
            }
        }
    })
}

class ActionUtils {
    #context: Context // hard private field to avoid access to it from action (to avoid ability to change tennantId)
    #mng: ModelManager

    public constructor(context: Context) {
        this.#context = context 
        this.#mng = ModelsManager.getInstance().getModelManager(this.#context.getCurrentUser()!.tenantId)
    }

    public getCache() { return this.#mng.getCache() }

    public getAttrGroups() {
        // TODO maybe we need to return copy of the data to avoid changing?
        return this.#mng.getAttrGroups()
    }

    public getRelations() {
        // TODO maybe we need to return copy of the data to avoid changing?
        return this.#mng.getRelations()
    }

    public getItemAttributes(item: Item, groupIdentifier?: string) {
        const attrArr: string[] = []
        const pathArr: number[] = item.path.split('.').map(elem => parseInt(elem))

        this.#mng.getAttrGroups().forEach(group => {
            if (group.getGroup().visible && (!groupIdentifier || group.getGroup().identifier === groupIdentifier)) {
                group.getAttributes().forEach(attr => {
                    if (attr.valid.includes(item.typeId)) {
                        for (let i=0; i<attr.visible.length; i++ ) {
                            const visible: number = attr.visible[i]
                            if (pathArr.includes(visible)) {
                                if (!attrArr.find(tst => tst === attr.identifier)) attrArr.push(attr.identifier)
                                break
                            }
                        }
                    }
                })
            }
        })
        return attrArr
    }

    public getRelationAttributes(rel: ItemRelation, groupIdentifier?: string) {
        const attrArr: string[] = []

        this.#mng.getAttrGroups().forEach(group => {
            if (group.getGroup().visible && (!groupIdentifier || group.getGroup().identifier === groupIdentifier)) {
                group.getAttributes().forEach(attr => {
                    if (attr.relations.includes(rel.relationId)) {
                        if (!attrArr.find(tst => tst === attr.identifier)) attrArr.push(attr.identifier)
                    }
                })
            }
        })
        return attrArr
    }

    public formatDate(date: Date, format: string) {
        return dateFormat(date, format)
    }

    private a:any = {"(": "_", ")": "_", "\"":"_","'":"_"," ": "_","Ё":"YO","Й":"I","Ц":"TS","У":"U","К":"K","Е":"E","Н":"N","Г":"G","Ш":"SH","Щ":"SCH","З":"Z","Х":"H","Ъ":"'","ё":"yo","й":"i","ц":"ts","у":"u","к":"k","е":"e","н":"n","г":"g","ш":"sh","щ":"sch","з":"z","х":"h","ъ":"'","Ф":"F","Ы":"I","В":"V","А":"a","П":"P","Р":"R","О":"O","Л":"L","Д":"D","Ж":"ZH","Э":"E","ф":"f","ы":"i","в":"v","а":"a","п":"p","р":"r","о":"o","л":"l","д":"d","ж":"zh","э":"e","Я":"Ya","Ч":"CH","С":"S","М":"M","И":"I","Т":"T","Ь":"'","Б":"B","Ю":"YU","я":"ya","ч":"ch","с":"s","м":"m","и":"i","т":"t","ь":"_","б":"b","ю":"yu"};
    public transliterate (word: string) {
      return word.split('').map( (char) => { 
        return this.a[char] || char; 
      }).join("")
    }
  

    public async createItem(parentIdentifier: string, typeIdentifier: string, identifier: string, name: any, values: any) {
        if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)

        const tst = await Item.applyScope(this.#context).findOne({
            where: {
                identifier: identifier
            }
        })
        if (tst) {
            throw new Error('Identifier: ' + identifier + ' already exists, tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const mng = ModelsManager.getInstance().getModelManager(this.#context.getCurrentUser()!.tenantId)
        const type = mng.getTypeByIdentifier(typeIdentifier)
        if (!type) {
            throw new Error('Failed to find type by identifier: ' + typeIdentifier + ', tenant: ' + mng.getTenantId())
        }
        const nTypeId = type.getValue()!.id;

        const results:any = await sequelize.query("SELECT nextval('items_id_seq')", { 
            type: QueryTypes.SELECT
        });
        const id = (results[0]).nextval
        
        let path:string
        if (parentIdentifier) {
            const parentItem = await Item.applyScope(this.#context).findOne({
                where: {
                    identifier: parentIdentifier
                }
            })
            if (!parentItem) {
                throw new Error('Failed to find parent item by identifier: ' + parentIdentifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
            }

            const parentType = mng.getTypeById(parentItem.typeId)!
            const tstType = parentType.getChildren().find(elem => (elem.getValue().id === nTypeId) || (elem.getValue().link === nTypeId))
            if (!tstType) {
                throw new Error('Failed to create item with type: ' + nTypeId + ' under type: ' + parentItem.typeId + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
            }

            parentIdentifier = parentItem.identifier
            path = parentItem.path + "." + id
        } else {
            const tstType = mng.getRoot().getChildren().find(elem => elem.getValue().id === nTypeId)
            if (!tstType) {
                throw new Error('Failed to create root item with type: ' + nTypeId + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
            }

            parentIdentifier = ''
            path = '' + id
        }

        if (!this.#context.canEditItem2(nTypeId, path)) {
            throw new Error('User :' + this.#context.getCurrentUser()?.login + ' can not create such item , tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const item = Item.build ({
            id: id,
            path: path,
            identifier: identifier,
            tenantId: this.#context.getCurrentUser()!.tenantId,
            createdBy: this.#context.getCurrentUser()!.login,
            updatedBy: this.#context.getCurrentUser()!.login,
            name: name,
            typeId: nTypeId,
            typeIdentifier: type.getValue().identifier,
            parentIdentifier: parentIdentifier, 
            values: null,
            fileOrigName: '',
            storagePath: '',
            mimeType: ''
        })

        if (!values) values = {}

        await processItemActions(this.#context, EventType.BeforeCreate, item, values, {}, false)

        filterValues(this.#context.getEditItemAttributes2(nTypeId, path), values)
        checkValues(mng, values)

        item.values = values

        await sequelize.transaction(async (t) => {
            await item.save({transaction: t})
        })

        await processItemActions(this.#context, EventType.AfterCreate, item, values, {}, false)

        if (audit.auditEnabled()) {
            const itemChanges: ItemChanges = {
                typeIdentifier: item.typeIdentifier,
                parentIdentifier: item.parentIdentifier,
                name: item.name,
                values: values
            }
            audit.auditItem(ChangeType.CREATE, item.id, item.identifier, {added: itemChanges}, this.#context.getCurrentUser()!.login, item.createdAt)
        }

        return makeItemProxy(item)
    }

    public async createItemRelation(relationIdentifier: string, identifier: string, itemIdentifier: string, targetIdentifier: string, values: any) {
        if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)

        const mng = ModelsManager.getInstance().getModelManager(this.#context.getCurrentUser()!.tenantId)
        const rel = mng.getRelationByIdentifier(relationIdentifier)
        if (!rel) {
            throw new Error('Failed to find relation by identifier: ' + relationIdentifier + ', tenant: ' + mng.getTenantId())
        }

        if (!this.#context.canEditItemRelation(rel.id)) {
            throw new Error('User :' + this.#context.getCurrentUser()?.login + ' can not edit item relation:' + rel.identifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const tst = await ItemRelation.applyScope(this.#context).findOne({
            where: {
                identifier: identifier
            }
        })
        if (tst) {
            throw new Error('Identifier: ' + identifier + ' already exists, tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const item = await Item.applyScope(this.#context).findOne({where: {identifier: itemIdentifier}})
        if (!item) {
            throw new Error('Failed to find item by id: ' + itemIdentifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const targetItem = await Item.applyScope(this.#context).findOne({where: {identifier: targetIdentifier}})
        if (!targetItem) {
            throw new Error('Failed to find target item by id: ' + targetIdentifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const tst3 = rel.targets.find((typeId: number) => typeId === targetItem.typeId)
        if (!tst3) {
            throw new Error('Relation with id: ' + relationIdentifier + ' can not have target with type: ' + targetItem.typeId + ', tenant: ' + mng.getTenantId())
        }

        if (!rel.multi) {
            const count = await ItemRelation.applyScope(this.#context).count( {
                where: {
                    itemIdentifier: itemIdentifier,
                    relationId: rel.id
                }
            })

            if (count > 0) {
                throw new Error('Relation with id: ' + itemIdentifier + ' can not have more then one target, tenant: ' + mng.getTenantId())
            }
        }

        const itemRelation = await ItemRelation.build ({
            identifier: identifier,
            tenantId: this.#context.getCurrentUser()!.tenantId,
            createdBy: this.#context.getCurrentUser()!.login,
            updatedBy: this.#context.getCurrentUser()!.login,
            relationId: rel.id,
            relationIdentifier: rel.identifier,
            itemId: item.id,
            itemIdentifier: item.identifier,
            targetId: targetItem.id,
            targetIdentifier: targetItem.identifier,
            values: null
        })

        if (!values) values = {}
        await processItemRelationActions(this.#context, EventType.BeforeCreate, itemRelation, values, false)

        filterValues(this.#context.getEditItemRelationAttributes(rel.id), values)
        checkValues(mng, values)

        itemRelation.values = values

        await sequelize.transaction(async (t) => {
            await itemRelation.save({transaction: t})
        })

        await processItemRelationActions(this.#context, EventType.AfterCreate, itemRelation, values, false)

        if (audit.auditEnabled()) {
            const itemRelationChanges: ItemRelationChanges = {
                relationIdentifier: itemRelation.relationIdentifier,
                itemIdentifier: itemRelation.itemIdentifier,
                targetIdentifier: itemRelation.targetIdentifier,
                values: values
            }
            audit.auditItemRelation(ChangeType.CREATE, itemRelation.id, itemRelation.identifier, {added: itemRelationChanges}, this.#context.getCurrentUser()!.login, itemRelation.createdAt)
        }

        return makeItemRelationProxy(itemRelation)
    }    

}