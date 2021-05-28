import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes } from 'sequelize'

export class Channel extends Base {
  public identifier!: string
  public name!: any
  public active!: boolean
  public type!: number
  public valid!: any
  public visible!: any
  public config!: any
  public mappings!: any
  public runtime!: any
}

export function init(sequelize: Sequelize):void {
  Channel.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      name: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
      },
      type: {
        type: DataTypes.INTEGER,
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
      config: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      mappings: {
        type: DataTypes.JSONB,
        allowNull: false,
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
      tableName: 'channels',
      paranoid: true,
      timestamps: true,
      sequelize: sequelize
  });    
}