import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes } from 'sequelize';
import Context from '../context';

export class User extends Base {
    public login!: string
    public name!: string
    public password!: string
    public email!: string
    public props!: any
    public roles!: any

    public static applyScope(context: Context) {
      return User.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
  }

export class Role extends Base {
  public identifier!: string
  public name!: string
  public configAccess!: any
  public relAccess!: any
  public itemAccess!: any
  public otherAccess!: any
  public static applyScope(context: Context) {
    return Role.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export class LoggedUser {
  public id!: number;
  public tenantId!: string;
  public login!: string;
}

export function init(sequelize: Sequelize):void {
    User.init({
        login: {
          type: new DataTypes.STRING(250),
          allowNull: false,
          unique: true
        },
        name: {
          type: new DataTypes.STRING(250),
          allowNull: false,
        },
        password: {
          type: new DataTypes.STRING(250),
          allowNull: false,
        },
        email: {
          type: DataTypes.STRING(250),
          allowNull: true,
        },
        props: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
        roles: {
          type: DataTypes.JSONB,
          allowNull: false,
        },
        ...BaseColumns
      }, {
        tableName: 'users',
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
    Role.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      name: {
        type: DataTypes.STRING(250),
        allowNull: false,
      },
      configAccess: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      relAccess: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      itemAccess: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      otherAccess: {
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
      tableName: 'roles',
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