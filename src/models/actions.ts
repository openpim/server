import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes } from 'sequelize'
import Context from '../context'

export enum EventType {
  BeforeCreate = 1,
  AfterCreate,
  BeforeUpdate,
  AfterUpdate,
  BeforeDelete,
  AfterDelete,
  ImportBeforeStart,
  ImportAfterEnd,
  BeforeBulkUpdateChannels,
  AfterBulkUpdateChannels
}

export enum TriggerType {
  Item = 1,
  ItemRelation,
  Button,
  AttrGroup,
  Attribute,
  TableButton,
  ImportConfig,
  LOV
}

export class Action extends Base {
  public identifier!: string
  public name!: any
  public code!: string
  public order!: number
  public triggers!: any
  public static applyScope(context: Context) {
    return Action.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export function init(sequelize: Sequelize):void {
  Action.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      name: {
        type: DataTypes.JSONB,
        allowNull: false
      },
      code: {
        type: new DataTypes.STRING(65535),
        allowNull: false
      },
      order: {
        type: new DataTypes.INTEGER,
        allowNull: false,
      },
      triggers: {
        type: DataTypes.JSONB,
        allowNull: false
      },
      ...BaseColumns,
      tenantId: { // override base for uniqueIdentifier
        type: new DataTypes.STRING(50),
        allowNull: false,
        unique: 'uniqueIdentifier'
      }
    }, {
      tableName: 'actions',
      paranoid: true,
      timestamps: true,
      sequelize: sequelize,
      scopes: {
        tenant(value) {
          return {
            where: {
              tenantId: value
            }
          }
        }
      }
  });
}