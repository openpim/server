import { IncomingMessage } from 'http';
import * as jwt from 'jsonwebtoken';
import { LoggedUser, User } from './models/users'
import { ModelsManager, UserWrapper } from './models/manager';
import { Item } from './models/items';

export default class Context {
    private req: IncomingMessage
    private currentUser: LoggedUser | null = null
    private user: UserWrapper | undefined = undefined

    private constructor(req: IncomingMessage) {
        this.req = req
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

    public static create = async (req: IncomingMessage)  => {

        const ctx = new Context(req)

        let token = ctx.req.headers['x-token']?.toString();
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
                case ConfigAccess.ACTIONS:
                    if (role.configAccess && role.configAccess.actions === 2) return true
                case ConfigAccess.DASHBOARDS:
                    if (role.configAccess && role.configAccess.dashboards === 2) return true
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
                case ConfigAccess.ACTIONS:
                    if (role.configAccess && (role.configAccess.actions === 1 || role.configAccess.actions === 2)) return true
                case ConfigAccess.DASHBOARDS:
                    if (role.configAccess && (role.configAccess.dashboards === 1 || role.configAccess.dashboards === 2)) return true
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

    public canViewItem(item: Item): boolean {
        if (!this.user) return false
        let access = -1
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.itemAccess.valid.find((typeId:number) => typeId === item.typeId)) {
                const pathArr = item.path.split('.').map((elem:string) => parseInt(elem))
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
            if(role.itemAccess.valid.find((typeId:number) => typeId === typeId)) {
                const pathArr = path.split('.').map((elem:string) => parseInt(elem))
                const tst = pathArr.find((id:number) => role.itemAccess.fromItems.includes(id))
                if (tst && role.itemAccess.access > access) access = role.itemAccess.access
            }
        }
        return access == -1 || access > 1
    }

    public getViewItemAttributes(item: Item): string[] | null {
        if (!this.user) return []

        const forbiddenGroups: number[] = []
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.itemAccess.valid.find((typeId:number) => typeId === item.typeId)) {
                const pathArr = item.path.split('.').map((elem:string) => parseInt(elem))
                const tst = pathArr.find((id:number) => role.itemAccess.fromItems.includes(id))
                if (tst && (role.itemAccess.access === 1 || role.itemAccess.access === 2)) {
                    role.itemAccess.groups.forEach((data: { access: number; groupId: number; }) => {
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

    public getEditItemAttributes(item: Item): string[] | null {
        return this.getEditItemAttributes2(item.typeId, item.path)
    }

    public getEditItemAttributes2(typeId: number, path: string): string[] | null {
        if (!this.user) return []

        const forbiddenGroups: number[] = []
        for (let i = 0; i < this.user.getRoles().length; i++) {
            const role = this.user.getRoles()[i]
            if(role.itemAccess.valid.find((typeId:number) => typeId === typeId)) {
                const pathArr = path.split('.').map((elem:string) => parseInt(elem))
                const tst = pathArr.find((id:number) => role.itemAccess.fromItems.includes(id))
                if (tst && (role.itemAccess.access === 1 || role.itemAccess.access === 2)) {
                    role.itemAccess.groups.forEach((data: { access: number; groupId: number; }) => {
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
            if (!groupIds.find((id:number) => forbiddenGroups.includes(id))) {
                res.push(attrIdentifier)
            }
        }
        return res    
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
    ACTIONS,
    DASHBOARDS
}
