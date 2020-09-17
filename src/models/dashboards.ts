import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes } from 'sequelize'

export class Dashboard extends Base {
  public identifier!: string
  public name!: any
  public users!: string[]
  public components!: any
}

export function init(sequelize: Sequelize):void {
  Dashboard.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      name: {
        type: DataTypes.JSONB,
        allowNull: false
      },
      users: {
        type: DataTypes.JSONB,
        allowNull: false
      },
      components: {
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
      tableName: 'dashboards',
      paranoid: true,
      timestamps: true,
      sequelize: sequelize
  });    
}