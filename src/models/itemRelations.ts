import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes} from 'sequelize';
import Context from '../context';
import { Item } from './items';

export interface IItemRelation {
  id: number
  identifier: string
  relationId: number
  item: IItemInfo
  target: IItemInfo
  values: any
}

export interface IItemInfo {
  id: number
  identifier: string
  name: any
}

export class ItemRelation extends Base {
    public identifier!: string
    public relationId!: number
    public relationIdentifier!: string
    public itemId!: number
    public itemIdentifier!: string
    public targetId!: number
    public targetIdentifier!: string
    public values: any

    public static applyScope(context: Context) {
      return ItemRelation.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
}

export function init(sequelize: Sequelize):void {
  ItemRelation.init({
        identifier: {
          type: new DataTypes.STRING(250),
          allowNull: false,
          unique: 'uniqueIdentifier'
        },
        itemId: {
          type: DataTypes.INTEGER.UNSIGNED,
          allowNull: false,
        },
        itemIdentifier: {
          type: new DataTypes.STRING(250),
          allowNull: false
        },
        relationId: {
          type: DataTypes.INTEGER.UNSIGNED,
          allowNull: false,
        },
        relationIdentifier: {
          type: new DataTypes.STRING(250),
          allowNull: false
        },
        targetId: {
          type: DataTypes.INTEGER.UNSIGNED,
          allowNull: false,
        },
        targetIdentifier: {
          type: new DataTypes.STRING(250),
          allowNull: false
        },
        values: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
          ...BaseColumns,
        tenantId: { // override base for uniqueIdentifier
          type: new DataTypes.STRING(50),
          allowNull: false,
          unique: 'uniqueIdentifier'
        }
      }, {
        tableName: 'itemRelations',
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