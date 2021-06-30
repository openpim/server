import Context, { ConfigAccess } from '../context'
import { ModelManager, ModelsManager, AttrGroupWrapper } from '../models/manager'
import { AttrGroup, Attribute, GroupsAttributes } from '../models/attributes'
import { sequelize } from '../models'
import { QueryTypes } from 'sequelize'

export default {
    Query: {
        getAttributesInfo: async (parent: any, args: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.getAttributesInfo()
        },
        getAttributeGroup: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.getAttrGroups().find(grp => grp.getGroup().id === id)
        },
        getAttribute: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const tst = mng.getAttribute(parseInt(id))
            if (tst) {
                const attr:any = tst.attr
                mng.getAttrGroups().forEach(group => {
                    group.getAttributes().forEach(groupAttr => {
                        if (groupAttr.id === attr.id) {
                            attr.groups.push(group.getGroup().identifier)
                        }
                    })
                })
            }
            return tst ? tst.attr : null
        }
    },
    Mutation: {
        createAttributeGroup: async (parent: any, { identifier, name, order, visible, options }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create attr group, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const results:any = await sequelize.query("SELECT nextval('\"attrGroups_id_seq\"')", { 
                type: QueryTypes.SELECT
            });
            const id = (results[0]).nextval

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst = mng.getAttrGroups().find(grp => grp.getGroup().identifier === identifier)
            if (tst) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const grp = await sequelize.transaction(async (t) => {
                return await AttrGroup.create ({
                    id: id,
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    order: order != null? order : null,
                    visible: visible || false,
                    options: options ? options : []
                }, {transaction: t})
            })

            mng.getAttrGroups().push(new AttrGroupWrapper(grp))
            return grp.id
        },
        updateAttributeGroup: async (parent: any, { id, name, order, visible, options }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update attr group, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst  = mng.getAttrGroups().find(grp => grp.getGroup().id === nId)
            if (!tst) {
                throw new Error('Failed to find attribute group by id: ' + nId + ', tenant: ' + mng.getTenantId())
            }

            const group = tst.getGroup()
            if (name) group.name = name
            if (order != null) group.order = order
            if (visible != null) group.visible = visible
            if (options != null) group.options = options
            group.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await group.save({transaction: t})
            })
            return group.id
        },
        removeAttributeGroup: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to delete attr group, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const idx = mng.getAttrGroups().findIndex(grp => grp.getGroup().id === nId)
            if (idx === -1) {
                throw new Error('Failed to find attribute group by id: ' + nId + ', tenant: ' + mng.getTenantId())
            }

            const group  = mng.getAttrGroups()[idx].getGroup()
            if ((await group!.countAttributes()) > 0) {
                throw new Error('Failed to remove group with attributes id: ' + nId + ', tenant: ' + mng.getTenantId())
            }

            // check Roles
            const tst1 = mng.getRoles().find(role => role.itemAccess.groups.includes(nId) || role.relAccess.groups.includes(nId))
            if (tst1) throw new Error('Can not remove this group because there are roles liked to it.');

            group.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            group.identifier = group.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await group.save({transaction: t})
                await group.destroy({transaction: t})
            })

            mng.getAttrGroups().splice(idx, 1)

            return true
        },
        createAttribute: async (parent: any, { groupId, identifier, name, order, valid, visible, relations, languageDependent, type, pattern, errorMessage, lov, richText, multiLine, options }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create attribute, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const nGroupId = parseInt(groupId)
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const group = mng.getAttrGroups().find(grp => grp.getGroup().id === nGroupId)
            if (!group) {
                throw new Error('Failed to find attribute group by id: ' + nGroupId + ', tenant: ' + mng.getTenantId())
            }

            if (mng.getAttributeByIdentifier(identifier) !== null) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const results:any = await sequelize.query("SELECT nextval('attributes_id_seq')", { 
                type: QueryTypes.SELECT
            });
            const id = (results[0]).nextval

            const val = valid ? valid.map((elem: string) => parseInt(elem)) : []
            const vis = visible ? visible.map((elem: string) => parseInt(elem)) : []
            const rels = relations ? relations.map((elem: string) => parseInt(elem)) : []

            const attr = await sequelize.transaction(async (t) => {
                const attr = await Attribute.create ({
                    id: id,
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    order: order != null? order : 0,
                    valid: val,
                    visible: vis,
                    relations: rels,
                    languageDependent: languageDependent || false,
                    type: type,
                    pattern: pattern || '',
                    errorMessage: errorMessage || {ru:""},
                    lov: lov ? parseInt(lov) : null,
                    richText: richText != null ? richText : false,
                    multiLine: multiLine != null ? multiLine : false,
                    options: options ? options : []
                }, {transaction: t})
                await group.getGroup().addAttribute(attr, {transaction: t})

                return attr
            })

            group.getAttributes().push(attr)
            return attr.id
        },
        updateAttribute: async (parent: any, { id, name, order, valid, visible, relations, languageDependent, type, pattern, errorMessage, lov, richText, multiLine, options }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update attribute, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst  = await mng.getAttribute(nId)
            if (!tst) {
                throw new Error('Failed to find attribute by id: ' + nId + ', tenant: ' + mng.getTenantId())
            }

            const attr = tst.attr
            if (name) attr.name = name
            if (valid) attr.valid = valid.map((elem: string) => parseInt(elem))
            if (visible) attr.visible = visible.map((elem: string) => parseInt(elem))
            if (relations) attr.relations = relations.map((elem: string) => parseInt(elem))
            if (order != null) attr.order = order
            if (languageDependent != null) attr.languageDependent = languageDependent
            if (type) attr.type = type
            if (pattern != null) attr.pattern = pattern
            if (errorMessage != null) attr.errorMessage = errorMessage
            if (lov) attr.lov = parseInt(lov)
            if (richText != null) attr.richText = richText
            if (multiLine != null) attr.multiLine = multiLine
            if (options != null) attr.options = options
            attr.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await attr.save({transaction: t})
            })

            // replace all such attributes in all groups to be the same (they are loaded as independent objects during init)
            for (let i=0; i < mng.getAttrGroups().length; i++) {
                const grp = mng.getAttrGroups()[i]
                const idx = grp.getAttributes().findIndex((attr) => { return attr.id === nId })
                if (idx !== -1) {
                    grp.getAttributes()[idx] = attr
                }
            }

            return attr.id
        },
        assignAttribute: async (parent: any, { id, groupId }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to assign attribute, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)
            const nGroupId = parseInt(groupId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tstAttr  = await mng.getAttribute(nId)
            if (!tstAttr) {
                throw new Error('Failed to find attribute by id: ' + nId + ', tenant: ' + mng.getTenantId())
            }
            const tstGroup = mng.getAttrGroups().find(grp => grp.getGroup().id === nGroupId)
            if (!tstGroup) {
                throw new Error('Failed to find attribute group by id: ' + nGroupId + ', tenant: ' + mng.getTenantId())
            }
            const save = tstAttr.attr // we must save a link to attr here because after addAttribute we will have clone of object
            await sequelize.transaction(async (t) => {
                await tstGroup.getGroup().addAttribute(tstAttr.attr, {transaction: t})
            })

            tstGroup.getAttributes().push(save)

            return true
        },
        unassignAttribute: async (parent: any, { id, groupId }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to unassign attribute, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)
            const nGroupId = parseInt(groupId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tstAttr  = await mng.getAttribute(nId)
            if (!tstAttr) {
                throw new Error('Failed to find attribute by id: ' + nId + ', tenant: ' + mng.getTenantId())
            }
            const tstGroup = mng.getAttrGroups().find(grp => grp.getGroup().id === nGroupId)
            if (!tstGroup) {
                throw new Error('Failed to find attribute group by id: ' + nGroupId + ', tenant: ' + mng.getTenantId())
            }

            let num: number = 0
            for (let i=0; i < mng.getAttrGroups().length; i++) {
                const grp = mng.getAttrGroups()[i]
                if (grp.getAttributes().findIndex((attr) => { return attr.id === nId })) {
                    num++
                }
            }
            if (num === 1) {
                throw new Error('Failed to unassign attribute from last group, id: ' + nId + ', group:' + nGroupId + ', tenant: ' + mng.getTenantId())
            }

            await sequelize.transaction(async (t) => {
                await tstGroup.getGroup().removeAttribute(tstAttr.attr, {transaction: t})
            })

            const idx = tstGroup.getAttributes().findIndex((attr) => { attr.id == nId })
            tstGroup.getAttributes().splice(idx, 1)

            return true
        },
        removeAttribute: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove attribute, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst  = await mng.getAttribute(nId)
            if (!tst) {
                throw new Error('Failed to find attribute by id: ' + nId + ', tenant: ' + mng.getTenantId())
            }

            const attr = tst.attr
            attr.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            attr.identifier = attr.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await attr.save({transaction: t})
                await attr.destroy({transaction: t})
            })

            for (let i=0; i < mng.getAttrGroups().length; i++) {
                const grp = mng.getAttrGroups()[i]
                const idx = grp.getAttributes().findIndex((attr) => { return attr.id === nId })
                if (idx !== -1) {
                    grp.getAttributes().splice(idx, 1)
                }
            }

            return true
        }
    }
}