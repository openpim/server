import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes} from 'sequelize';
import Context from '../context';

export class SavedSearch extends Base {
    public identifier!: string
    public entity!: string
    public name!: any
    public public!: boolean
    public extended!: boolean
    public filters!: any
    public whereClause!: any
    public user!: string
    public static applyScope(context: Context) {
      return SavedSearch.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
}

export class SavedColumns extends Base {
  public identifier!: string
  public name!: any
  public public!: boolean
  public columns!: any
  public user!: string
  public static applyScope(context: Context) {
    return SavedColumns.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
  }
}

export function init(sequelize: Sequelize):void {
    SavedSearch.init({
        identifier: {
          type: new DataTypes.STRING(250),
          allowNull: false,
          unique: 'uniqueIdentifierSearch'
        },
        entity: {
          type: new DataTypes.STRING(50),
          allowNull: false,
          defaultValue: 'ITEM'
        },
        name: {
          type: DataTypes.JSONB,
          allowNull: false,
        },
        public: {
          type: 'BOOLEAN',
          allowNull: false
        },
        extended: {
          type: 'BOOLEAN',
          allowNull: false
        },
        filters: {
            type: DataTypes.JSONB,
            allowNull: false,
        },        
        whereClause: {
          type: DataTypes.JSONB,
          allowNull: false,
        },       
        user: {
            type: new DataTypes.STRING(250),
            allowNull: false
        },
        ...BaseColumns,
        tenantId: { // override base for uniqueIdentifier
          type: new DataTypes.STRING(50),
          allowNull: false,
          unique: 'uniqueIdentifierSearch'
        }
      }, {
        tableName: 'savedSearch',
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
    SavedColumns.init({
      identifier: {
        type: new DataTypes.STRING(250),
        allowNull: false,
        unique: 'uniqueIdentifierColumns'
      },
      name: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      public: {
        type: 'BOOLEAN',
        allowNull: false
      },
      columns: {
          type: DataTypes.JSONB,
          allowNull: false,
      },        
      user: {
          type: new DataTypes.STRING(250),
          allowNull: false
      },
      ...BaseColumns,
      tenantId: { // override base for uniqueIdentifier
        type: new DataTypes.STRING(50),
        allowNull: false,
        unique: 'uniqueIdentifierColumns'
      }
    }, {
      tableName: 'savedColumns',
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