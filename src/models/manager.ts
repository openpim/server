import { Type } from './types'
import { AttrGroup, Attribute } from './attributes'
import { Relation } from './relations'
import { Language } from './languages'
import { sequelize } from '../models'
import { Role, User } from './users'
import { Action } from './actions'
import { Dashboard } from './dashboards'
import { WhereOptions } from 'sequelize'
import { Channel } from './channels'

import logger from '../logger'
import NodeCache from 'node-cache'

export class ModelManager {
    private typeRoot: TreeNode<void> = new TreeNode<void>()
    private tenantId: string
    private attrGroups: AttrGroupWrapper[] = []
    private relations: Relation[] = []
    private languages: Language[] = []
    private channels: Channel[] = []
    private actions: Action[] = []
    private dashboards: Dashboard[] = []
    private actionsCache:any = {}
    private roles: Role[] = []
    private users: UserWrapper[] = []
    private cache = new NodeCache()

    public constructor(tenantId: string) { this.tenantId = tenantId }

    public getTenantId() { return this.tenantId }

    public getRoot() { return this.typeRoot }

    public getRoles() { return this.roles }
    public getUsers() { return this.users }

    public getCache() { return this.cache }

    public getLanguages(): Language[] {
        return this.languages
    }

    public getChannels(): Channel[] {
        return this.channels
    }

    public getActions(): Action[] {
        return this.actions
    }

    public getDashboards(): Dashboard[] {
        return this.dashboards
    }

    public getActionsCache(): any {
        return this.actionsCache
    }

    public getRelations(): Relation[] {
        return this.relations
    }

    public dumpRelations() {
        return this.relations.map((rel) => {
            const data = {internalId: 0}
            Object.assign(data, rel.get({ plain: true }))
            data.internalId = rel.id
            return data
        })
    }

    public getRelationById(id: number): Relation | undefined {
        return this.relations.find( (rel) => rel.id === id)    
    }

    public getRelationByIdentifier(identifier: string): Relation | undefined {
        return this.relations.find( (rel) => rel.identifier === identifier)    
    }

    public getTypes() : any {
        const result:any[] = []
        this.dumpChildren(result, this.typeRoot.getChildren())
        return result
    }

    private dumpChildren(arr:any[], children: TreeNode<Type>[]) {
        for (var i = 0; i < children.length; i++) {
            const child = children[i]
            const data = {children: [], internalId: 0, link: 0, name: '', icon: '', iconColor: ''}
            Object.assign(data, child.getValue()?.get({ plain: true }))
            data.internalId = child.getValue()!.id
            if (data.link !== 0) {
                const linkParent = this.getTypeById(data.link)
                const linkType = <Type>linkParent!.getValue()
                data.name = linkType.name
                data.icon = linkType.icon
                data.iconColor = linkType.iconColor
            }
            arr.push(data)
            // console.log(data)
            this.dumpChildren(data.children, child.getChildren())
        }
    }

    public addType(parentId: number, type: Type) {
        if (parentId) {
            const parent = this.getTypeById(parentId)
            if (parent) {
                const node = new TreeNode<Type>(type, parent)
                parent.getChildren().push(node)
            } else {
                logger.error('Failed to find parent by id: ' + parentId + ' in manager: ' + this.tenantId)
            }
        } else {
            const node = new TreeNode<Type>(type, this.typeRoot)
            this.typeRoot.getChildren().push(node)
        }
    }

    public getTypeById(id: number): TreeNode<any> | null {
        const res =  this.findNode(id, this.typeRoot.getChildren(), (id, item) => item.getValue().id === id)
        return res
    }

    public getTypeByLinkId(id: number): TreeNode<any> | null {
        const res =  this.findNode(id, this.typeRoot.getChildren(), (id, item) => item.getValue().link === id)
        return res
    }

    public getTypeByIdentifier(identifier: string): TreeNode<any> | null {
        return this.findNode(identifier, this.typeRoot.getChildren(), (id, item) => item.getValue().identifier === identifier)
    }

    private findNode (id: any, children:TreeNode<any>[], comparator: ((id: any, item: TreeNode<any>) => boolean)): TreeNode<any> | null {
        for (var i = 0; i < children.length; i++) {
          const item = children[i]
          // console.log('check-', item.getValue().id, typeof item.getValue().id, id, typeof id)
          if (comparator(id, item)) {
            return item
          } else {
            const found = this.findNode(id, item.getChildren(), comparator)
            if (found) {
              return found
            }
          }
        }
        return null
    }

    public getAttrGroups(): AttrGroupWrapper[] {
        return this.attrGroups
    }

    public getAttributesInfo() : any[] {
        const result:any[] = []
        let attrId = Date.now()
        this.attrGroups.forEach((grp) => {
            const attributes :any[] = []
            const group: {attributes:any[], internalId: number, group: boolean, Attributes?: []} = {attributes: attributes, internalId: 0, group: true, Attributes: []}
            Object.assign(group, grp.getGroup().get({ plain: true }))
            delete group.Attributes
            group.internalId = grp.getGroup().id
            group.attributes = grp.getAttributes().map( attr => {
                const data: {internalId: number, group: boolean, id:number, GroupsAttributes?:string} = {internalId: 0, group: false, id:0, GroupsAttributes:''}
                Object.assign(data, attr.get({ plain: true }))
                data.internalId = attr.id
                data.id = attrId++ // we have to assign unique id
    
                delete data.GroupsAttributes
                return data
            })
            result.push(group)
        }) 
        return result
    }

    public getAttribute(id: number) : { attr: Attribute, groups: AttrGroup[] } | null {
        const groups: AttrGroup[] = []
        let attr: Attribute | null = null
        for (var i = 0; i < this.attrGroups.length; i++) {
            const group = this.attrGroups[i]
            const attributes = group.getAttributes()
            for (var j = 0; j < attributes.length; j++) {
                if (attributes[j].id === id) {
                    attr = attributes[j]
                    groups.push(group.getGroup())
                }
            }
        }  
        return attr ? {attr:attr, groups:groups} : null
    }

    public getAttributeByIdentifier(identifier: string) : { attr: Attribute, groups: AttrGroup[] } | null {
        const groups: AttrGroup[] = []
        let attr: Attribute | null = null
        for (var i = 0; i < this.attrGroups.length; i++) {
            const group = this.attrGroups[i]
            const attributes = group.getAttributes()
            for (var j = 0; j < attributes.length; j++) {
                if (attributes[j].identifier === identifier) {
                    attr = attributes[j]
                    groups.push(group.getGroup())
                }
            }
        }  
        return attr ? {attr:attr, groups:groups} : null
    }
}

export class ModelsManager {
    private static instance: ModelsManager
    private tenantMap: Record<string, ModelManager> = {}
    private channelTypes: number[] = [1, 5] // external and external with mapping by default
    
    private constructor() { }
   
    public static getInstance(): ModelsManager {
        if (!ModelsManager.instance) {
            ModelsManager.instance = new ModelsManager()
        }

        return ModelsManager.instance
    }

    public getTenants() {
        return Object.entries(this.tenantMap).map(entry => entry[0])
    }

    public getModelManager(tenant: string): ModelManager {
        let tst = this.tenantMap[tenant]
        if (!tst) {
            logger.warn('Can not find model for tenant: ' + tenant);
            // const mng = new ModelManager(tenant)
            // this.tenantMap[tenant] = mng
        }
        return tst
    }

    public getChannelTypes() { return this.channelTypes }

    public async init(channelTypes?: number[]) {
        if (channelTypes) this.channelTypes = channelTypes
        let where: WhereOptions | undefined = undefined
        if (process.argv.length > 3) {
            where = {tenantId: process.argv.splice(3)}
        }
        await this.initModels(where)
    }

    public async reloadModel(tenantId: string) {
        delete this.tenantMap[tenantId]
        this.initModels({tenantId: [tenantId]})
    }

    public async initModels(where: WhereOptions | undefined) {
        await this.initLanguages(where)

        /*
        const types: Type[] = await sequelize.query('SELECT * FROM types order by "tenantId", path', {
            model: Type,
            mapToModel: true
        }); */

        const types: Type[] = await Type.findAll({
            where: where,
            order: [['tenantId', 'DESC'],['path', 'ASC']]})

        let mng: ModelManager
        let currentNode: TreeNode<any>
        let currentLevel: number
        types.forEach( (type) => {
            // console.log('loading type-' + type.path)
            if (!mng || mng.getTenantId() !== type.tenantId) {
                mng = this.tenantMap[type.tenantId]
                currentNode = mng.getRoot()
                currentLevel = 1
            }

            const arr = type.path.split('.')
            /* console.log(currentLevel, arr.length, 
                (currentNode.getValue() ? 'cur-'+currentNode.getValue() : 'null'), 
                (currentNode.getParent() ? 'par-'+currentNode.getParent()! : "no parent")) */
            if (currentLevel > arr.length) {
                // go to one parent up
                while(currentLevel > arr.length) {
                    currentNode = currentNode.getParent()!
                    currentLevel--
                }
            }

            const node = new TreeNode<Type>(type, currentNode)
            // console.log('parent -' + JSON.stringify(currentNode.getValue()))
            currentNode.getChildren().push(node)
            currentNode = node
            currentLevel++
        })

        await this.initAttributes(where)
        await this.initRelations(where)
        await this.initRoles(where)
        await this.initActions(where)
        await this.initDashboards(where)
        await this.initChannels(where)

        logger.info('Data models were loaded')
    }

    public async initRoles(where: WhereOptions | undefined) {
        // TODO optimize this to load data by 1 select with join
        const roles = await Role.findAll({
            where: where,
            order: [['tenantId', 'DESC']]})
        if (!roles) return

        let mng: ModelManager | null = null
        for (var i = 0; i < roles.length; i++) {
            const role = roles[i];
            if (!mng || mng.getTenantId() !== role.tenantId) {
                mng = this.tenantMap[role.tenantId]
            }
            (<any>role).internalId = role.id
            mng.getRoles().push(role)
        }

        const users = await User.findAll({
            where: where,
            order: [['tenantId', 'DESC']]})
        if (!users) return

        mng = null
        for (var i = 0; i < users.length; i++) {
            const user = users[i];

            if (user.tenantId === '0') continue // super user, skip it

            if (!mng || mng.getTenantId() !== user.tenantId) {
                mng = this.tenantMap[user.tenantId]
            }
            (<any>user).internalId = user.id;
            const roles = user.roles ? user.roles.map((roleId: number) => mng!.getRoles().find(role => role.id === roleId)) : []
            mng.getUsers().push(new UserWrapper(user, roles))
        }
    }

    public async initAttributes(where: WhereOptions | undefined) {
        // TODO optimize this to load data by 1 select with join
        const groups = await AttrGroup.findAll({
            where: where,
            include: [{model: Attribute}],
            order: [['tenantId', 'DESC']]})
        if (!groups) return

        let mng: ModelManager | null = null
        for (var i = 0; i < groups.length; i++) {
            const grp = groups[i];
            if (!mng || mng.getTenantId() !== grp.tenantId) {
                mng = this.tenantMap[grp.tenantId]
            }
            mng.getAttrGroups().push(new AttrGroupWrapper(grp, await grp.getAttributes()))
        }
    }

    public async initRelations(where: WhereOptions | undefined) {
        const rels = await Relation.findAll({
            where: where,
            order: [['tenantId', 'DESC']]})
        if (!rels) return

        let mng: ModelManager | null = null
        for (var i = 0; i < rels.length; i++) {
            const rel = rels[i];
            if (!mng || mng.getTenantId() !== rel.tenantId) {
                mng = this.tenantMap[rel.tenantId]
            }
            mng.getRelations().push(rel)
        }
    }

    public async initActions(where: WhereOptions | undefined) {
        const actions = await Action.findAll({
            where: where,
            order: [['tenantId', 'DESC']]})
        if (!actions) return

        let mng: ModelManager | null = null
        for (var i = 0; i < actions.length; i++) {
            const action = actions[i];
            if (!mng || mng.getTenantId() !== action.tenantId) {
                mng = this.tenantMap[action.tenantId]
            }
            mng.getActions().push(action)
        }
    }

    public async initDashboards(where: WhereOptions | undefined) {
        const dashboards = await Dashboard.findAll({
            where: where,
            order: [['tenantId', 'DESC']]})
        if (!dashboards) return

        let mng: ModelManager | null = null
        for (var i = 0; i < dashboards.length; i++) {
            const dashboard = dashboards[i];
            if (!mng || mng.getTenantId() !== dashboard.tenantId) {
                mng = this.tenantMap[dashboard.tenantId]
            }
            mng.getDashboards().push(dashboard)
        }
    }

    public async initChannels(where: WhereOptions | undefined) {
        const items = await Channel.findAll({
            where: where,
            order: [['tenantId', 'DESC']]})
        if (!items) return

        let mng: ModelManager | null = null
        for (var i = 0; i < items.length; i++) {
            const chan = items[i];
            if (!mng || mng.getTenantId() !== chan.tenantId) {
                mng = this.tenantMap[chan.tenantId]
            }
            mng.getChannels().push(chan)
        }
    }

    public async initLanguages(where: WhereOptions | undefined) {
        const languages = await Language.findAll({
            where: where,
            order: [['tenantId', 'DESC'], ['id', 'ASC']]})
        if (!languages) return

        let mng: ModelManager | null = null
        for (var i = 0; i < languages.length; i++) {
            const lang = languages[i];
            if (!mng || mng.getTenantId() !== lang.tenantId) {
                mng = new ModelManager(lang.tenantId)
                this.tenantMap[lang.tenantId] = mng
            }
            mng.getLanguages().push(lang)
        }
    }

}

export class TreeNode<T> {
    private parent: TreeNode<any> | null = null
    private children: TreeNode<any>[] = []
    private value: T | null = null

    public constructor(value?: T, parent?: TreeNode<any>) {
        if (parent) {
            this.parent = parent
        }
        if (value) {
            this.value = value
        }
    }

    public getParent(): TreeNode<any> | null {
        return this.parent
    }

    public getChildren(): TreeNode<any>[] {
        return this.children
    }

    public getValue(): T | null {
        return this.value
    }

    public deleteChild(child: TreeNode<any>): void {
        const idx = this.children.indexOf(child)
        if (idx !== -1) this.children.splice(idx, 1)
    }
}

export class AttrGroupWrapper {
    private group: AttrGroup
    private attributes: Attribute[] = []

    public constructor(group: AttrGroup, attributes?: Attribute[]) {
        this.group = group
        if (attributes && attributes.length > 0) {
            this.attributes = attributes
        }
    }

    public getGroup() {
        return this.group
    }

    public getAttributes() {
        return this.attributes
    }
}

export class UserWrapper {
    private user: User
    private roles: Role[] = []

    public constructor(user: User, roles?: Role[]) {
        this.user = user
        if (roles && roles.length > 0) {
            this.roles = roles
        }
    }

    public getUser() {
        return this.user
    }

    public getRoles() {
        return this.roles
    }

    public setRoles(roles: Role[]) {
        this.roles = roles
    }

}
