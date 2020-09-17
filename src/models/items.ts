import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes} from 'sequelize';
import Context from '../context';
import { ItemRelation } from './itemRelations';

export class Item extends Base {
    public identifier!: string
    public path!: string
    public typeId!: number
    public typeIdentifier!: string
    public parentIdentifier!: string
    public name!: any
    public values: any
    public fileOrigName!: string
    public storagePath!: string
    public mimeType!: string
    public static applyScope(context: Context) {
      return Item.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
}

export function init(sequelize: Sequelize):void {
    Item.init({
        identifier: {
          type: new DataTypes.STRING(250),
          allowNull: false,
          unique: 'uniqueIdentifier'
        },
        path: {
          type: 'LTREE',
          allowNull: false,
          unique: true
        },
        name: {
          type: DataTypes.JSONB,
          allowNull: false,
        },
        typeId: {
          type: DataTypes.INTEGER.UNSIGNED,
          allowNull: false,
        },
        typeIdentifier: {
          type: new DataTypes.STRING(250),
          allowNull: false
        },
        parentIdentifier: {
          type: new DataTypes.STRING(250),
          allowNull: false
        },
        values: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
        fileOrigName: {
          type: new DataTypes.STRING(250),
          allowNull: false
        },
        storagePath: {
          type: new DataTypes.STRING(500),
          allowNull: false
        },
        mimeType: {
          type: new DataTypes.STRING(250),
          allowNull: false
        },
        ...BaseColumns,
        tenantId: { // override base for uniqueIdentifier
          type: new DataTypes.STRING(50),
          allowNull: false,
          unique: 'uniqueIdentifier'
        }
      }, {
        tableName: 'items',
        paranoid: true,
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