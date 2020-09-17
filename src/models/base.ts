import { Model, DataTypes } from 'sequelize';

export class Base extends Model {
    public id!: number; 
    public tenantId!: string

    public createdBy!: string;
    public updatedBy!: string;
  
    // timestamps!
    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

export default {
    id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
    },
    tenantId: {
        type: new DataTypes.STRING(50),
        allowNull: false
    },
    createdBy: {
        type: new DataTypes.STRING(250),
        allowNull: false
    },
    updatedBy: {
        type: new DataTypes.STRING(250),
        allowNull: false
    }
}