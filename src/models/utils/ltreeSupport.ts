/* 
const { DataTypes, Utils } = require('Sequelize');

export class LTREE extends DataTypes.ABSTRACT {
  // Mandatory: complete definition of the new type in the database
  toSql() {
    return 'LTREE'
  }

  // Optional: validator function
  validate(value: any, options: any) {
    return (typeof value === 'string');
  }

  // Optional: value stringifier before sending to database
  _stringify(value: { toString: () => any; }) {
    return value.toString();
  }

  // Optional: parser for values received from the database
  static parse(value: any) {
    return value;
  }
}

export function createLtreeDataType() {

  // Mandatory: set the type key
  LTREE.prototype.key = LTREE.key = 'LTREE';

  // Mandatory: add the new type to DataTypes. Optionally wrap it on `Utils.classToInvokable` to
  // be able to use this datatype directly without having to call `new` on it.
  DataTypes.LTREE = Utils.classToInvokable(LTREE);

  // Optional: disable escaping after stringifier. Do this at your own risk, since this opens opportunity for SQL injections.
  // DataTypes.SOMETYPE.escape = false;

  // =====
  const PgTypes = DataTypes.postgres;

  // Mandatory: map postgres datatype name
  DataTypes.LTREE.types.postgres = ['ltree'];

  // Mandatory: create a postgres-specific child datatype with its own parse
  // method. The parser will be dynamically mapped to the OID of pg_new_type.
  PgTypes.LTREE = function LTREE() {
    if (!(this instanceof PgTypes.LTREE)) {
      return new PgTypes.LTREE();
    }
    DataTypes.LTREE.apply(this, arguments);
  }
  const util = require('util'); // Built-in Node package
  util.inherits(PgTypes.LTREE, DataTypes.LTREE);

  // Mandatory: create, override or reassign a postgres-specific parser
  // PgTypes.SOMETYPE.parse = value => value;
  PgTypes.LTREE.parse = DataTypes.LTREE.parse;

  // Optional: add or override methods of the postgres-specific datatype
  // like toSql, escape, validate, _stringify, _sanitize...

} */