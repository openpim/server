import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes } from 'sequelize'
import Context from '../context'

export class Relation extends Base {
  public identifier!: string
  public name!: any
  public sources!: any
  public targets!: any
  public child!:boolean
  public multi!:boolean
  public order!: number
  public static applyScope(context: Context) {
    return Relation.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export function init(sequelize: Sequelize):void {
  Relation.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      name: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      sources: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      targets: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      child: {
        type: 'BOOLEAN',
        allowNull: false,
      },
      multi: {
        type: 'BOOLEAN',
        allowNull: false,
      },
      order: {
        type: new DataTypes.INTEGER,
        allowNull: false,
      },
      ...BaseColumns,
      tenantId: { // override base for uniqueIdentifier
        type: new DataTypes.STRING(50),
        allowNull: false,
        unique: 'uniqueIdentifier'
      }
    }, {
      tableName: 'relations',
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