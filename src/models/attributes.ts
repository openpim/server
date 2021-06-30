import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes, Model } from 'sequelize'
import { HasManyGetAssociationsMixin, HasManyAddAssociationMixin, HasManyHasAssociationMixin, HasManyCountAssociationsMixin, HasManyCreateAssociationMixin, HasManyRemoveAssociationMixin } from 'sequelize'
import Context from '../context'

export class GroupsAttributes extends Model {
  // public createdBy!: string;
  // public updatedBy!: string;
}

export class AttrGroup extends Base {
    public identifier!: string
    public name!: any
    public visible!: boolean
    public order!:number
    public options!: any

    public getAttributes!: HasManyGetAssociationsMixin<Attribute>
    public addAttribute!: HasManyAddAssociationMixin<Attribute, number>;
    public hasAttribute!: HasManyHasAssociationMixin<Attribute, number>;
    public countAttributes!: HasManyCountAssociationsMixin;
    public createAttribute!: HasManyCreateAssociationMixin<Attribute>;    
    public removeAttribute!: HasManyRemoveAssociationMixin<Attribute, number>;    
    public static applyScope(context: Context) {
      return AttrGroup.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
}

export class Attribute extends Base {
  public identifier!: string
  public name!: any
  public order!: number
  public valid!: any
  public visible!: any
  public relations!: any
  public languageDependent!: boolean
  public type!: number
  public pattern!: string
  public errorMessage!: any
  public lov!: number
  public richText!: boolean
  public multiLine!: boolean
  public options!: any
  public static applyScope(context: Context) {
    return Attribute.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export function init(sequelize: Sequelize):void {
  AttrGroup.init({
        identifier: {
          type: new DataTypes.STRING(250),
          allowNull: false,
          unique: 'uniqueIdentifier'
        },
        name: {
          type: DataTypes.JSONB,
          allowNull: false,
        },
        order: {
          type: new DataTypes.INTEGER,
          allowNull: false,
        },
        visible: {
          type: 'BOOLEAN',
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
        tableName: 'attrGroups',
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
    Attribute.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifier'
      },
      name: {
        type: DataTypes.JSONB,
        allowNull: false,
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
      relations: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      languageDependent: {
        type: 'BOOLEAN',
        allowNull: false,
      },
      type: {
        type: new DataTypes.INTEGER,
        allowNull: false,
      },
      pattern: {
        type: new DataTypes.STRING(250),
        allowNull: true
      },
      errorMessage: {
        type: DataTypes.JSONB,
        allowNull: true
      },
      lov: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true
      },
      richText: {
        type: 'BOOLEAN',
        allowNull: false,
      },
      multiLine: {
        type: 'BOOLEAN',
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
      tableName: 'attributes',
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
  GroupsAttributes.init({
    /* createdBy: {
      type: new DataTypes.STRING(250),
      allowNull: false
    },
    updatedBy: {
      type: new DataTypes.STRING(250),
      allowNull: false
    } */
  }, {
    tableName: 'group_attribute',
    paranoid: false,
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
  AttrGroup.belongsToMany(Attribute, {through: GroupsAttributes});    
  Attribute.belongsToMany(AttrGroup, {through: GroupsAttributes});    
}