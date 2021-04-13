import { Client } from '@elastic/elasticsearch'

class Audit {
    private client: Client | null = null

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
        await this.client!.index({
            index: "items",
            body: {
                itemId: id,
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
        await this.client!.index({
            index: "item_relations",
            body: {
                itemRelationId: id,
                identifier: identifier,
                operation: change,
                user: login,
                changedAt: changedAt,
                data: item
            }
        })
    }

    public async getItemHistory(id: number, offset: number, limit: number, order: any) {
    if (!this.auditEnabled()) return {count: 0, rows: []}
        const sort = order ? order.map((elem:any) => { const data:any = {}; data[elem[0]] = elem[1]; return data; } ) : null
        const response = await this.client!.search({
            index: "items",
            from: offset,
            size: limit,
            body: {
                query: {
                  term: {
                    itemId: id
                  }
                },
                sort: sort
            }
        })
        return { count: response.body.hits.total.value, rows: response.body.hits.hits.map((elem:any) => { elem._source.id = elem._id; return elem._source })}
    }

    public async getItemRelationHistory(id: number, offset: number, limit: number, order: any) {
        if (!this.auditEnabled()) return {count: 0, rows: []}
            const sort = order ? order.map((elem:any) => { const data:any = {}; data[elem[0]] = elem[1]; return data; } ) : null
            const response = await this.client!.search({
                index: "item_relations",
                from: offset,
                size: limit,
                body: {
                    query: {
                      term: {
                        itemRelationId: id
                      }
                    },
                    sort: sort
                }
            })
            return { count: response.body.hits.total.value, rows: response.body.hits.hits.map((elem:any) => { elem._source.id = elem._id; return elem._source })}
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