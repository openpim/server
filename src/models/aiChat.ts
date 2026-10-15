import { DataTypes, Model, Sequelize } from 'sequelize'

export class AiChat extends Model {
    public id!: string
    public tenantId!: string
    public userId!: number
    public title!: string
}

export class AiChatMessage extends Model {
    public id!: string
    public chatId!: string
    public tenantId!: string
    public userId!: number
    public role!: string
    public content!: string
    public status!: string
    public requestId!: string | null
    public replyToId!: string | null
    public runId!: string | null
    public leaseUntil!: Date | null
    public error!: string | null
    public trace!: any[]
    public contextTruncated!: boolean
    public createdAt!: Date
}

export function init(sequelize: Sequelize): void {
    const privateHooks = {
        beforeFind: (options: any) => { options.logging = false },
        beforeCount: (options: any) => { options.logging = false },
        beforeSave: (instance: Model, options: any) => { options.logging = false },
        beforeDestroy: (instance: Model, options: any) => { options.logging = false },
        beforeBulkUpdate: (options: any) => { options.logging = false },
        beforeBulkDestroy: (options: any) => { options.logging = false }
    }
    AiChat.init({
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: { type: DataTypes.STRING(250), allowNull: false },
        userId: { type: DataTypes.INTEGER, allowNull: false },
        title: { type: DataTypes.STRING(250), allowNull: false, defaultValue: 'Новый чат' }
    }, { sequelize, hooks: privateHooks, tableName: 'aiChats', timestamps: true, indexes: [{ fields: ['tenantId', 'userId', 'updatedAt'] }] })
    AiChatMessage.init({
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        chatId: { type: DataTypes.UUID, allowNull: false, references: { model: 'aiChats', key: 'id' }, onDelete: 'CASCADE' },
        tenantId: { type: DataTypes.STRING(250), allowNull: false },
        userId: { type: DataTypes.INTEGER, allowNull: false },
        role: { type: DataTypes.STRING(20), allowNull: false },
        content: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        status: { type: DataTypes.STRING(20), allowNull: false },
        requestId: { type: DataTypes.UUID, allowNull: true },
        replyToId: { type: DataTypes.UUID, allowNull: true },
        runId: { type: DataTypes.UUID, allowNull: true },
        leaseUntil: { type: DataTypes.DATE, allowNull: true },
        error: { type: DataTypes.STRING(500), allowNull: true },
        trace: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        contextTruncated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
    }, { sequelize, hooks: privateHooks, tableName: 'aiChatMessages', timestamps: true, indexes: [
        { fields: ['chatId', 'createdAt', 'id'] },
        { unique: true, fields: ['tenantId', 'userId', 'requestId'] },
        { unique: true, fields: ['replyToId'] },
        { fields: ['status', 'leaseUntil'] }
    ] })
}
