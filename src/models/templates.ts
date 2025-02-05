import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes } from 'sequelize'
import Context from '../context'

export class Template extends Base {
  public identifier!: string
  public name!: any
  public template!: string
  public templateRichtext!: string
  public order!: number
  public valid!: any
  public visible!: any
  public options!: any
  public static applyScope(context: Context) {
    return Template.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export function init(sequelize: Sequelize):void {
  Template.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      name: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      template: {
        type: new DataTypes.TEXT,
        allowNull: true,
      },
      templateRichtext: {
        type: new DataTypes.TEXT,
        allowNull: true,
      },
      order: {
        type: new DataTypes.INTEGER,
        allowNull: false,
      },
      valid: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      visible: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      options: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      ...BaseColumns,
      tenantId: { // override base for uniqueIdentifier
        type: new DataTypes.STRING(50),
        allowNull: false,
        unique: 'uniqueIdentifier'
      }
    }, {
      tableName: 'templates',
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
  })
}