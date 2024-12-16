import { Sequelize } from 'sequelize'
import { calculateMetrics } from '../metrics'
// import { createLtreeDataType } from './utils/ltreeSupport'
// createLtreeDataType()

import * as users from './users'
import * as types from './types'
import * as attributes from './attributes'
import * as relations from './relations'
import * as items from './items'
import * as lang from './languages'
import * as itemRelations from './itemRelations'
import * as lovs from './lovs'
import * as search from './search'
import * as actions from './actions'
import * as dashboards from './dashboards'
import * as channels from './channels'
import * as importConfigs from './importConfigs'
import * as collections from './collections'
import * as collectionItems from './collectionItems'
import * as processes from './processes'
import * as templates from './templates'

import logger from '../logger'

let sequelize:Sequelize

export { sequelize }

export async function initModels() {
    let dialectOptions = {}
    if (process.env.OPENPIM_DATABASE_OPTIONS) {
        dialectOptions = JSON.parse(process.env.OPENPIM_DATABASE_OPTIONS)
    }
    sequelize = new Sequelize(
        <string>process.env.DATABASE_NAME,
        <string>process.env.DATABASE_USER,
        <string>process.env.DATABASE_PASSWORD, {
        host: process.env.DATABASE_URL,
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT) : 5432,
        dialect: 'postgres',
        dialectOptions: dialectOptions,
        benchmark: true,
        logging: (sql: string, timingMs?: number) => {
            logger.debug(`${sql} - [Execution time: ${timingMs}ms]`)
            if (process.env.OPENPIM_DATABASE_METRICS && process.env.OPENPIM_DATABASE_METRICS === 'true') {
                calculateMetrics(sql, timingMs)
            }
        },
        pool: {
            max: 50,
            min: 0,
            idle: 30000,
            acquire: 600000,
            evict: 1000
        }
    })

    users.init(sequelize)
    types.init(sequelize)
    attributes.init(sequelize)
    relations.init(sequelize)
    lang.init(sequelize)
    lovs.init(sequelize)
    search.init(sequelize)
    items.init(sequelize)
    itemRelations.init(sequelize)
    actions.init(sequelize)
    dashboards.init(sequelize)
    channels.init(sequelize)
    importConfigs.init(sequelize)
    collections.init(sequelize)
    collectionItems.init(sequelize)
    processes.init(sequelize)
    templates.init(sequelize)

    items.Item.hasMany(itemRelations.ItemRelation, {sourceKey: 'id', as: 'sourceRelation', foreignKey: 'itemId'})
    itemRelations.ItemRelation.belongsTo(items.Item,{targetKey: 'id', as: 'sourceItem', foreignKey: 'itemId'})

    items.Item.hasMany(collectionItems.CollectionItems, {sourceKey: 'id', as: 'collectionItems', foreignKey: 'itemId'})

    items.Item.hasMany(itemRelations.ItemRelation, {sourceKey: 'id', as: 'targetRelation', foreignKey: 'targetId'})
    itemRelations.ItemRelation.belongsTo(items.Item,{targetKey: 'id', as: 'targetItem', foreignKey: 'targetId'})

    await sequelize.sync();
}

