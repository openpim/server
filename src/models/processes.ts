import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes } from 'sequelize'
import Context from '../context'

export class Process extends Base {
  public identifier!: string
  public title!: string
  public active!: boolean
  public status!: string
  public finishTime!: any
  public storagePath!: string
  public mimeType!: string
  public fileName!: string
  public log!: string
  public runtime!: any
  public static applyScope(context: Context) {
    return Process.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export function init(sequelize: Sequelize):void {
  Process.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      title: {
        type: new DataTypes.STRING(2500),
        allowNull: false,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
      },
      status: {
        type: new DataTypes.STRING(250),
        allowNull: false,
      },
      finishTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      storagePath: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      mimeType: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      fileName: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      log: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
        runtime: {
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
      tableName: 'processes',
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