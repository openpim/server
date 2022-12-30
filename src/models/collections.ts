import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes} from 'sequelize';
import Context from '../context';

export class Collection extends Base {
    public identifier!: string
    public name!: any
    public public!: boolean
    public user!: string
    public static applyScope(context: Context) {
      return Collection.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
}

export function init(sequelize: Sequelize):void {
    Collection.init({
        identifier: {
          type: new DataTypes.STRING(250),
          allowNull: false,
          unique: 'uniqueIdentifier'
        },
        name: {
          type: DataTypes.JSONB,
          allowNull: false,
        },
        public: {
          type: 'BOOLEAN',
          allowNull: false
        },     
        user: {
            type: new DataTypes.STRING(250),
            allowNull: false
        },
        ...BaseColumns
      }, {
        tableName: 'collections',
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
}