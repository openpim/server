import { IncomingMessage } from 'http';
import * as jwt from 'jsonwebtoken';
import { LoggedUser, User } from './models/users'
import { ModelsManager, UserWrapper } from './models/manager';
import { Item } from './models/items';
import { LOV } from './models/lovs';
import * as fs from 'fs'

export default class Context {
    private currentUser: LoggedUser | null = null
    private user: UserWrapper | undefined = undefined
    private static externalAuthFunction:any = undefined
    private static externalSecurityFunction:any = undefined

    private constructor() {
    }

    public static async init() {
        const filesRoot = process.env.FILES_ROOT!;
        const externalAuthPath = filesRoot + '/modules/auth.js'
        if (fs.existsSync(externalAuthPath)) {
            const { default: auth } = await import(externalAuthPath)
            Context.externalAuthFunction = auth
        }
        const externalSecurityPath = filesRoot + '/modules/security.js'
        if (fs.existsSync(externalSecurityPath)) {
            const { default: externalRestrictionsInSQL } = await import(externalSecurityPath)
            Context.externalSecurityFunction = externalRestrictionsInSQL
        }
    }

    public getCurrentUser() {
        return this.currentUser
    }

    public getUser() {
        return this.user
    }

    public checkAuth() {
        if (!this.currentUser || (this.currentUser.tenantId !== '0' && !this.user)) throw new Error('User is not authenticated')
    }

    public async externalAuth(login: string, password: string) {
        if (!Context.externalAuthFunction) return null
        try {
            return await Context.externalAuthFunction(login, password)
        } catch (err) {
            return null
        }                        
    }

    public static create = async (req: IncomingMessage)  => {
        const ctx = new Context()
        let token = req.headers['x-token']?.toString();
        if (!token) {
            const idx = req.url?.indexOf('token=')
            if (idx && idx !== -1) token = req.url?.substr(idx + 6)
        }
        if (token) {
            try {
                const res = await jwt.verify(token, <string>process.env.SECRET);
                ctx.currentUser = <LoggedUser>res
                if (ctx.currentUser.tenantId !== '0') {
                    const mng = ModelsManager.getInstance().getModelManager(ctx.currentUser.tenantId)
                    ctx.user = mng?.getUsers().find(user => user.getUser().id === ctx.currentUser!.id)
                }
            } catch (e) {
                throw new jwt.JsonWebTokenError('Your session expired. Sign in again.');
            }
        }

        return ctx
    }

    public static createAs = (login: string, tenantId: string)  => {
        const ctx = new Context()
        const mng = ModelsManager.getInstance().getModelManager(tenantId)
        if (!mng) {
            throw new jwt.JsonWebTokenError('Failed to find Manager by tenantId: ' + tenantId);
        }
        ctx.user = mng!.getUsers().find(user => user.getUser().login === login)
        if (!ctx.user) {
            throw new jwt.JsonWebTokenError('Failed to find User by login: ' + login);
        }
        ctx.currentUser = {
            id: ctx.user!.getUser().id,
            tenantId: tenantId,
            login: login
        }
        return ctx
    }


    public isAdmin(): boolean {
        return !!this.user!.getRoles().find(role => role.identifier === 'admin')
    }

    public canEditConfig(item:ConfigAccess): boolean {
        if (!this.user) return false

        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            
            switch(item){
                case ConfigAccess.TYPES:
                    if (role.configAccess && role.configAccess.types === 2) return true
                case ConfigAccess.ATTRIBUTES:
                    if (role.configAccess && role.configAccess.attributes === 2) return true
                case ConfigAccess.RELATIONS:
                    if (role.configAccess && role.configAccess.relations === 2) return true
                case ConfigAccess.USERS:
                    if (role.configAccess && role.configAccess.users === 2) return true
                case ConfigAccess.ROLES:
                    if (role.configAccess && role.configAccess.roles === 2) return true
                case ConfigAccess.LANGUAGES:
                    if (role.configAccess && role.configAccess.languages === 2) return true
                case ConfigAccess.LOVS:
                    if (role.configAccess && role.configAccess.lovs === 2) return true
                case ConfigAccess.CHANNELS:
                    if (role.configAccess && role.configAccess.channels === 2) return true
                case ConfigAccess.ACTIONS:
                    if (role.configAccess && role.configAccess.actions === 2) return true
                case ConfigAccess.DASHBOARDS:
                    if (role.configAccess && role.configAccess.dashboards === 2) return true
                case ConfigAccess.COLLECTIONS:
                    return true
                case ConfigAccess.COLLECTIONITEMS:
                    return true
                }
        }
        return false
    }

    public canViewConfig(item:ConfigAccess): boolean {
        if (!this.user) return false

        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            
            switch(item){
                case ConfigAccess.TYPES:
                    if (role.configAccess && (role.configAccess.types === 1 || role.configAccess.types === 2)) return true
                case ConfigAccess.ATTRIBUTES:
                    if (role.configAccess && (role.configAccess.attributes === 1 || role.configAccess.attributes === 2)) return true
                case ConfigAccess.RELATIONS:
                    if (role.configAccess && (role.configAccess.relations === 1 || role.configAccess.relations === 2)) return true
                case ConfigAccess.USERS:
                    if (role.configAccess && (role.configAccess.users === 1 || role.configAccess.users === 2)) return true
                case ConfigAccess.ROLES:
                    if (role.configAccess && (role.configAccess.roles === 1 || role.configAccess.roles === 2)) return true
                case ConfigAccess.LANGUAGES:
                    if (role.configAccess && (role.configAccess.languages === 1 || role.configAccess.languages === 2)) return true
                case ConfigAccess.LOVS:
                    if (role.configAccess && (role.configAccess.lovs === 1 || role.configAccess.lovs === 2)) return true
                case ConfigAccess.CHANNELS:
                    if (role.configAccess && (role.configAccess.channels === 1 || role.configAccess.channels === 2)) return true
                case ConfigAccess.ACTIONS:
                    if (role.configAccess && (role.configAccess.actions === 1 || role.configAccess.actions === 2)) return true
                case ConfigAccess.DASHBOARDS:
                    if (role.configAccess && (role.configAccess.dashboards === 1 || role.configAccess.dashboards === 2)) return true
                case ConfigAccess.COLLECTIONS:
                    return true
                case ConfigAccess.COLLECTIONITEMS:
                    return true
                }
        }
        return false
    }

    public canViewItemRelation(relationId: number): boolean {
        if (!this.user) return false
        let access = -1
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.relAccess.relations.find((id:number) => id === relationId)) {
                if (role.relAccess.access > access) access = role.relAccess.access
            }
        }
        return access == -1 || access > 0
    }

    public canEditItemRelation(relationId: number): boolean {
        if (!this.user) return false
        let access = -1
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.relAccess.relations.find((id:number) => id === relationId)) {
                if (role.relAccess.access > access) access = role.relAccess.access
            }
        }
        return access == -1 || access > 1
    }

    public getViewItemRelationAttributes(relationId: number): string[] | null {
        if (!this.user) return []

        const forbiddenGroups: number[] = []
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.relAccess.relations.find((id:number) => id === relationId)) {
                if (role.relAccess.access === 1 || role.relAccess.access === 2) {
                    role.relAccess.groups.forEach((data: { access: number; groupId: number; }) => {
                      if (data.access === 0) {
                          forbiddenGroups.push(data.groupId)
                      }  
                    })
                }
            }
        }
        if (forbiddenGroups.length === 0) {
            return null
        } else {
            return this.filterGroups(forbiddenGroups)
        }
    }

    public getEditItemRelationAttributes(relationId: number): string[] | null {
        if (!this.user) return []

        const forbiddenGroups: number[] = []
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.relAccess.relations.find((id:number) => id === relationId)) {
                if (role.relAccess.access === 2) {
                    role.relAccess.groups.forEach((data: { access: number; groupId: number; }) => {
                      if (data.access === 0 || data.access === 1) {
                          forbiddenGroups.push(data.groupId)
                      }  
                    })
                }
            }
        }
        if (forbiddenGroups.length === 0) {
            return null
        } else {
            return this.filterGroups(forbiddenGroups)
        }
    }

    public canViewChannel(channelIdentifier: string): boolean {
        if (!this.user) return false
        const mng = ModelsManager.getInstance().getModelManager(this.currentUser!.tenantId)
        const chan = mng.getChannels().find(chan => chan.identifier === channelIdentifier)
        if (!chan) return false

        let access = 2
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            const tst = role.channelAccess.find((data : { channelId: number; access: number }) => data.channelId === chan.id)
            if(tst) {
                if (tst.access < access) access = tst.access
            }
        }
        return access > 0
    }

    public canEditChannel(channelIdentifier: string): boolean {
        if (!this.user) return false
        const mng = ModelsManager.getInstance().getModelManager(this.currentUser!.tenantId)
        const chan = mng.getChannels().find(chan => chan.identifier === channelIdentifier)
        if (!chan) return false

        let access = 2
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            const tst = role.channelAccess.find((data : { channelId: number; access: number }) => data.channelId === chan.id)
            if(tst) {
                if (tst.access < access) access = tst.access
            }
        }
        return access === 2
    }

    public canViewItem(item: Item): boolean {
        return this.canViewItem2(item.typeId, item.path)
    }
    public canViewItem2(typeId: number, path: string): boolean {
        if (!this.user) return false
        let access = -1
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.itemAccess.valid.some((tId:number) => tId === typeId)) {
                const pathArr = path.split('.').map((elem:string) => parseInt(elem))
                const tst = pathArr.find((id:number) => role.itemAccess.fromItems.includes(id))
                if (tst && role.itemAccess.access > access) access = role.itemAccess.access
            }
        }
        return access == -1 || access > 0
    }

    public canEditItem(item: Item): boolean {
        return this.canEditItem2(item.typeId, item.path)
    }

    public canEditItem2(typeId: number, path: string): boolean {
        if (!this.user) return false
        let access = -1
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.itemAccess.valid.some((tId:number) => tId === typeId)) {
                const pathArr = path.split('.').map((elem:string) => parseInt(elem))
                const tst = pathArr.find((id:number) => role.itemAccess.fromItems.includes(id))
                if (tst && role.itemAccess.access > access) access = role.itemAccess.access
            }
        }
        return access == -1 || access > 1
    }

    public getViewItemAttributes(item: Item): string[] | null {
        if (!this.user) return []

        const mng = ModelsManager.getInstance().getModelManager(this.currentUser!.tenantId);
        const groups = mng.getAttrGroups()
        const forbiddenGroups: number[] = []

        for (let j = 0; j < groups.length; j++) {
            const group = groups[j].getGroup()
            let access:number = -1
            for (let i = 0; i < this.user.getRoles().length; i++) {
                const role = this.user.getRoles()[i]
                if(role.itemAccess.valid.some((tId:number) => tId === item.typeId)) {
                    const pathArr = item.path.split('.').map((elem:string) => parseInt(elem))
                    const tst = pathArr.find((id:number) => role.itemAccess.fromItems.includes(id))
                    if (tst && (role.itemAccess.access === 1 || role.itemAccess.access === 2)) {
                        const tst: { access: number; groupId: number; } = role.itemAccess.groups.find((elem: any) => elem.groupId === group.id)
                        if (tst && tst.access > access) access = tst.access
                    }
                }
            }
            if (access === 0) {
                forbiddenGroups.push(group.id)
            }
        }
        if (forbiddenGroups.length === 0) {
            return null
        } else {
            return this.filterGroups(forbiddenGroups)
        }
    }

    public getEditItemAttributes(item: Item): string[] | null {
        return this.getEditItemAttributes2(item.typeId, item.path)
    }

    public getEditItemAttributes2(typeId: number, path: string): string[] | null {
        if (!this.user) return []

        const mng = ModelsManager.getInstance().getModelManager(this.currentUser!.tenantId);
        const groups = mng.getAttrGroups()
        const forbiddenGroups: number[] = []

        for (let j = 0; j < groups.length; j++) {
            const group = groups[j].getGroup()
            let access:number = -1
            for (let i = 0; i < this.user.getRoles().length; i++) {
                const role = this.user.getRoles()[i]
                if(role.itemAccess.valid.some((tId:number) => tId === typeId)) {
                    const pathArr = path.split('.').map((elem:string) => parseInt(elem))
                    const tst = pathArr.find((id:number) => role.itemAccess.fromItems.includes(id))
                    if (tst && (role.itemAccess.access === 1 || role.itemAccess.access === 2)) {
                        const tst: { access: number; groupId: number; } = role.itemAccess.groups.find((elem: any) => elem.groupId === group.id)
                        if (tst && tst.access > access) access = tst.access
                    }
                }
            }
            if (access === 0 || access === 1) {
                forbiddenGroups.push(group.id)
            }
        }
        if (forbiddenGroups.length === 0) {
            return null
        } else {
            return this.filterGroups(forbiddenGroups)
        }
    }

    private filterGroups(forbiddenGroups: number[]): string[] {
        const mng = ModelsManager.getInstance().getModelManager(this.currentUser!.tenantId);

        const res: string[] = []
        const attrMap:any = {}
        mng.getAttrGroups().forEach(grp => {
            grp.getAttributes().forEach( attr => {
                if (attrMap[attr.identifier]) {
                    attrMap[attr.identifier].push(grp.getGroup().id)
                    if (attr.type === 8) attrMap[attr.identifier + '_text'].push(grp.getGroup().id) // URL attribute
                } else {
                    attrMap[attr.identifier] = [grp.getGroup().id]
                    if (attr.type === 8) attrMap[attr.identifier + '_text'] = [grp.getGroup().id] // URL attribute
                }
            })
        })

        for (const attrIdentifier in attrMap) {
            const groupIds = attrMap[attrIdentifier]
            if (groupIds.find((id:number) => !forbiddenGroups.includes(id))) {
                res.push(attrIdentifier)
            }
        }
        return res    
    }

    public async generateRestrictionsInSQL(prefix: string, putAnd: boolean, processRelations = true) {
        if (!this.user) throw new Error('No user')

        let sql = putAnd ? ' and (' : ' ('
        let start = true
        let restrictedTypes:any[] = []
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i];
            
            if (role.identifier === 'admin') return ''

            if (role.itemAccess.access === 0 && role.itemAccess.valid.length > 0 && role.itemAccess.fromItems.length > 0) {
                // we have restrictions
                restrictedTypes = restrictedTypes.concat(role.itemAccess.valid)

                if (start) {
                    sql += '('
                    start = false
                } else {
                    sql += ' and '
                }

                const validArr = role.itemAccess.valid.join(',')
                sql += ' not (' + prefix + '"typeId" in (' + validArr + ') and ('
                role.itemAccess.fromItems.forEach((fromItem:any, idx:any, arr:any) => {
                    sql += prefix + "path ~ '*." + fromItem + ".*' "
                    if (idx != arr.length-1) sql += ' or '
                })
                sql += '))'
            }
        }

        if (restrictedTypes.length > 0) {
            // add allowed levels for restricted types
            for (let i = 0; i < this.user.getRoles().length; i++) {
                const role = this.user.getRoles()[i];
                if (role.itemAccess.access > 0 && role.itemAccess.valid.length > 0 && role.itemAccess.fromItems.length > 0 &&  role.itemAccess.valid.some((typeId:any) => restrictedTypes.includes(typeId))) {
                    const validArr = role.itemAccess.valid.join(',')
                    sql += ' or (' + prefix + '"typeId" in (' + validArr + ') and ('
                    role.itemAccess.fromItems.forEach((fromItem:any, idx:any, arr:any) => {
                        sql += prefix + "path ~ '*." + fromItem + ".*' "
                        if (idx != arr.length-1) sql += ' or '
                    })
                    sql += '))'
    
                }
            }
        }

        if (!start) sql += ')'

        const mng = ModelsManager.getInstance().getModelManager(this.getCurrentUser()!.tenantId)
        const relationsToCheck = mng.getRelations().filter(relation => 
            relation.options && 
            relation.options.some((option:any) => option.name === 'participatesInAccess' && option.value === 'true'))
        if (processRelations) {
            if (relationsToCheck.length > 0) {
                // need to check item access through relations also
                // object is visible if it has corresponding relations as a target and user can see any source object
                const relationIds = relationsToCheck.map(relation => relation.id).join(',')
                let targetTypes: any[] = []
                relationsToCheck.forEach(relation => {
                    targetTypes = targetTypes.concat(relation.targets)
                })
                const targetTypeIds = targetTypes.join(',')
                
                if (!start) sql += ' and '
                const restrict = await this.generateRestrictionsInSQL('check_item.', false, false)
                sql += 
                ` ( not `+prefix+`"typeId" in (`+targetTypeIds+`) or exists ( select check_item.id from items check_item, "itemRelations" check_item_relations 
                    where check_item_relations."relationId" in (`+relationIds+`) and ` + (prefix?prefix: 'items.') + `id = check_item_relations."targetId" 
                    and check_item."deletedAt" is null and check_item_relations."deletedAt" is null
                    and check_item_relations."itemId" = check_item.id ` + (!restrict.includes('()')?' and '+restrict : '') + ` 
                )) `
            }
        }

        if (restrictedTypes.length === 0 && relationsToCheck.length === 0 && !Context.externalSecurityFunction) return ''

        if (Context.externalSecurityFunction) {
            const useAnd = restrictedTypes.length === 0 && relationsToCheck.length === 0 ? putAnd : true
            sql += await Context.externalSecurityFunction(prefix, useAnd, this, LOV)
        }

        sql += ')'
        return sql
    }
}

export enum ConfigAccess {
    TYPES,
    ATTRIBUTES,
    RELATIONS,
    USERS,
    ROLES,
    LANGUAGES,
    LOVS,
    CHANNELS,
    ACTIONS,
    DASHBOARDS,
    COLLECTIONS,
    COLLECTIONITEMS
}
