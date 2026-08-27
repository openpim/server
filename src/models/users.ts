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
    public options!: any
    public external!: boolean
    public static applyScope(context: Context) {
      return User.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
  }

export class Role extends Base {
  public identifier!: string
  public name!: string
  public order!: number
  public parentIds!: any
  public group!: boolean
  public configAccess!: any
  public relAccess!: any
  public itemAccess!: any
  public otherAccess!: any
  public channelAccess!: any
  public options!: any
  public static applyScope(context: Context) {
    return Role.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export function expandRoleIds(roleIds: any, roles: Role[]): number[] {
  if (!Array.isArray(roleIds)) return []

  const result = new Set<number>()
  const sameId = (left: any, right: any) => String(left) === String(right)
  roleIds.forEach(id => {
    const role = roles.find(item => sameId(item.id, id))
    if (!role) return

    if (role.group) {
      roles.forEach(child => {
        if (!child.group && Array.isArray(child.parentIds) && child.parentIds.some(parentId => sameId(parentId, role.id))) {
          result.add(child.id)
        }
      })
    } else {
      result.add(role.id)
    }
  })
  return Array.from(result)
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
        options: {
          type: DataTypes.JSONB,
          allowNull: false,
        },
        external: {
          type: DataTypes.VIRTUAL(DataTypes.BOOLEAN, ['password']),
            get() {
              return this.password === '#external#'
            }
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
      order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      parentIds: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      group: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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
      channelAccess: {
        type: DataTypes.JSONB,
        allowNull: false,
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
