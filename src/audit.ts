const { Client } = require('@elastic/elasticsearch')

class Audit {
    private client: any

    public constructor() {
        if (this.auditEnabled()) {
            this.client = new Client({
                node: process.env.AUDIT_URL
            })
        }
    }    

    public auditEnabled(): boolean {
        return !! process.env.AUDIT_URL 
    }

    public async auditItem(change: ChangeType, id: number, identifier: string, item: AuditItem, login: string, changedAt: Date) {
        if (!this.auditEnabled()) return
        await this.client.index({
            index: "items",
            body: {
                id: id,
                identifier: identifier,
                operation: change,
                user: login,
                changedAt: changedAt,
                data: item
            }
        })
    }

    public async auditItemRelation(change: ChangeType, id: number, identifier: string, item: AuditItemRelation, login: string, changedAt: Date) {
        if (!this.auditEnabled()) return
        await this.client.index({
            index: "item_relations",
            body: {
                id: id,
                identifier: identifier,
                operation: change,
                user: login,
                changedAt: changedAt,
                data: item
            }
        })
    }

}

export enum ChangeType {
    CREATE = 1,
    UPDATE,
    DELETE
}

export interface AuditItem {
    added?: ItemChanges,
    changed?: ItemChanges,
    old?: ItemChanges,
    deleted?: ItemChanges
}

export interface ItemChanges {
    typeIdentifier?: string
    parentIdentifier?: string
    name?: any
    values?: any
    fileOrigName?: string
    mimeType?: string
}

export interface AuditItemRelation {
    added?: ItemRelationChanges,
    changed?: ItemRelationChanges,
    old?: ItemRelationChanges,
    deleted?: ItemRelationChanges
}

export interface ItemRelationChanges {
    relationIdentifier?: string
    itemIdentifier?: string
    targetIdentifier?: string
    values?: any
}  

const audit = new Audit()
export default audit