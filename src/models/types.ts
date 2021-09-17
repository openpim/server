import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes} from 'sequelize';
import Context from '../context';

export class Type extends Base {
    public path!: string
    public identifier!: string
    public link!:number
    public name!: any
    public icon!: string
    public iconColor!: string
    public file!: boolean
    public mainImage!: number
    public images!: any
    public options!: any
    public static applyScope(context: Context) {
      return Type.scope({ method: ['tenant', context.getCurrentUser()!.tenantId] })
    }
}

export function init(sequelize: Sequelize):void {
    Type.init({
        path: {
          type: 'LTREE',
          allowNull: false,
          unique: true
        },
        identifier: {
          type: new DataTypes.STRING(250),
          allowNull: false,
          unique: 'uniqueIdentifier'
        },
        link: {
          type: DataTypes.INTEGER.UNSIGNED,
          allowNull: false,
        },
        name: {
          type: DataTypes.JSONB,
          allowNull: false,
        },
        icon: {
          type: new DataTypes.STRING(50),
          allowNull: true,
        },
        iconColor: {
          type: new DataTypes.STRING(50),
          allowNull: true,
        },
        file: {
          type: 'BOOLEAN',
          allowNull: false
        },
        mainImage: {
          type: DataTypes.INTEGER.UNSIGNED,
          allowNull: false,
        },
        images: {
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
        tableName: 'types',
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