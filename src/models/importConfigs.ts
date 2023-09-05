import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes } from 'sequelize'
import Context from '../context'

export class ImportConfig extends Base {
  public identifier!: string
  public name!: any
  public type!: number
  public mappings!: any
  public filedata!: any
  public config!: any
  public static applyScope(context: Context) {
    return ImportConfig.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export function init(sequelize: Sequelize):void {
  ImportConfig.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      name: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      type: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      mappings: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      filedata: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      config: {
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
      tableName: 'importConfigs',
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