import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes} from 'sequelize'
import Context from '../context'
import { Item } from './items'

export class CollectionItems extends Base {
    public itemId!: number
    public collectionId!: number
    public static applyScope(context: Context) {
      return CollectionItems.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
}

export function init(sequelize: Sequelize):void {
    CollectionItems.init({
      itemId: {
          type: DataTypes.INTEGER,
          allowNull: false
        },
        collectionId: {
          type: DataTypes.INTEGER,
          allowNull: false,
        },
        ...BaseColumns
      }, {
        tableName: 'collectionItems',
        paranoid: false,
        timestamps: true,
        sequelize: sequelize, // this bit is important
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