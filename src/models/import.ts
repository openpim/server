import { Base } from './base'
import BaseColumns from './base'
import { Sequelize, DataTypes} from 'sequelize';
import Context from '../context';

export interface IItemImportRequest {
  identifier: string
  delete: boolean
  skipActions: boolean
  typeIdentifier: string
  parentIdentifier: string
  name: any
  values: any
  channels: any
}

export class ImportResponse {
  identifier: string
  result: ImportResult | null = null
  id: string = ''
  warnings: ReturnMessage[] = []
  errors: ReturnMessage[] = []
  constructor(identifier: string){
    this.identifier = identifier
  }
  public addError(msg: ReturnMessage) {
    this.errors.push(msg)
  }  
  public addWarning(msg: ReturnMessage) {
    this.warnings.push(msg)
  }  
}

export class ReturnMessage {
  public static WrongIdentifier = new ReturnMessage(1, "Identifier must not has spaces and must be in English only")
  public static ItemNotFound = new ReturnMessage(2, "Failed to find Item by identifier")
  public static ItemExist = new ReturnMessage(3, "Item with such identifier already exists")
  public static TypeRequired = new ReturnMessage(4, "Item must has typeIdentifier specified")
  public static ItemTypeNotFound = new ReturnMessage(5, "Failed to find Type by identifier")
  public static WrongTypeRoot = new ReturnMessage(6, "Can not create item with such typeIdentifier under root")
  public static WrongTypeParent = new ReturnMessage(7, "Can not create item with such typeIdentifier under this parent")
  public static ParentNotFound = new ReturnMessage(8, "Failed to find Parent Item by identifier")
  public static ItemNoAccess = new ReturnMessage(9, "This user can not edit this item")
  public static ItemDeleteFailed = new ReturnMessage(10, "Can not delete this item because there are attributes or roles with links to it")
  public static ItemDeleteFailedChildren = new ReturnMessage(11, "Can not delete this item because it has children, remove them first")
  public static ItemDeleteFailedRelations = new ReturnMessage(12, "Can not delete this item because it has relations, remove them first")
  public static ItemMoveFailedChildren = new ReturnMessage(13, "Can not move this item because it has children, remove them first")

  public static ItemRelationNotFound = new ReturnMessage(100, "Failed to find Item Relation by identifier")
  public static ItemRelationExist = new ReturnMessage(101, "Item Relation with such identifier already exists")
  public static ItemRelationRelationIdentifierRequired = new ReturnMessage(102, "Item must has relationIdentifier specified")
  public static ItemRelationUpdateRelationIdentifier = new ReturnMessage(103, "Relation Identifier can not be set during update, will ignore it")
  public static ItemRelationRelationNotFound = new ReturnMessage(104, "Failed to find Relation by identifier")
  public static ItemRelationSourceIdentifierRequired = new ReturnMessage(105, "Item must has sourceIdentifier specified")
  public static ItemRelationSourceNotFound = new ReturnMessage(106, "Failed to find item by source identifier")
  public static ItemRelationWrongSource = new ReturnMessage(107, "Item with such source identifier can not be source of this relation")
  public static ItemRelationTargetIdentifierRequired = new ReturnMessage(108, "Item must has targetIdentifier specified")
  public static ItemRelationTargetNotFound = new ReturnMessage(109, "Failed to find item by target identifier")
  public static ItemRelationWrongTarget = new ReturnMessage(110, "Item with such target identifier can not be target of this relation")
  public static ItemRelationNotMulty = new ReturnMessage(111, "This relation allows only one item relation and it is already exists")
  public static ItemRelationNoAccess = new ReturnMessage(112, "This user can not edit this relation")

  public static TypeNotFound = new ReturnMessage(200, "Failed to find Type by identifier")
  public static TypeDeleteFailed = new ReturnMessage(201, "Can not remove type with child types, remove children and try again")
  public static TypeExist = new ReturnMessage(202, "Type with such identifier already exists")
  public static TypeParentNotFound = new ReturnMessage(203, "Failed to find parent Type by identifier")
  public static TypeLinkNotFound = new ReturnMessage(204, "Failed to find link Type by identifier")
  public static TypeParentRequired = new ReturnMessage(205, "Type must has parentIdentifier specified")
  public static TypeUpdateParent = new ReturnMessage(206, "Parent Identifier can not be set during update, will ignore it")
  public static TypeUpdateLink = new ReturnMessage(207, "Link Identifier can not be set during update, will ignore it")
  public static TypeCanNotDelete = new ReturnMessage(208, "Can not delete this type because there are objects that has links to it")

  public static RelationNotFound = new ReturnMessage(300, "Failed to find Relation by identifier")
  public static RelationExist = new ReturnMessage(301, "Relation with such identifier already exists")
  public static RelationCanNotDelete = new ReturnMessage(302, "Can not delete this relation because there are objects with links to it")

  public static AttrGroupNotFound = new ReturnMessage(400, "Failed to find Attribute Group by identifier")
  public static AttrGroupExist = new ReturnMessage(401, "Attribute Group with such identifier already exists")
  public static AttrGroupDeleteFailed1 = new ReturnMessage(402, "Failed to remove attribute group with existing attributes")
  public static AttrGroupDeleteFailed2 = new ReturnMessage(403, "Failed to remove attribute group because there are roles with links to it")

  public static AttributeNotFound = new ReturnMessage(500, "Failed to find Attribute by identifier")
  public static AttributeExist = new ReturnMessage(501, "Attribute with such identifier already exists")
  public static AttributeGroupRequired = new ReturnMessage(502, "Attribute must have at least one group specified")

  public static RoleNotFound = new ReturnMessage(600, "Failed to find Role by identifier")
  public static RoleExist = new ReturnMessage(601, "Role with such identifier already exists")
  public static RoleAdminCanNotBeUpdated = new ReturnMessage(602, "Administrator role can not be changed")
  public static RoleDeleteFailed = new ReturnMessage(603, "Failed to remove role because there are users with links to it")

  public static UserNotFound = new ReturnMessage(700, "Failed to find User by login")
  public static UserExist = new ReturnMessage(701, "User with such login already exists")
  public static WrongLogin = new ReturnMessage(702, "Login must not has spaces and must be in English")
  public static UserDeleteFailed = new ReturnMessage(703, "Can not remove last user with Administrator role")

  public static LOVNotFound = new ReturnMessage(800, "Failed to find List of values by identifier")
  public static LOVExist = new ReturnMessage(801, "List of values with such identifier already exists")
  public static LOVDeleteFailed = new ReturnMessage(802, "Failed to remove list of value because there are attributes with links to it")
  
  code: number
  message: string
  constructor(code: number, message: string) {
    this.code = code
    this.message = message
  }
}

export interface IImportConfig {
  mode: ImportMode
  errors: ErrorProcessing
}

export enum ImportMode {
  CREATE_ONLY,
  UPDATE_ONLY,
  CREATE_UPDATE
}

export enum ErrorProcessing {
  PROCESS_WARN,
  WARN_REJECTED
}

export enum ImportResult {
  CREATED = "CREATED",
  UPDATED = "UPDATED",
  DELETED = "DELETED",
  REJECTED = "REJECTED"
}

export class ImportResponses {
  types: ImportResponse[] = []
  relations: ImportResponse[] = []
  items: ImportResponse[] = []
  itemRelations: ImportResponse[] = []
  attrGroups: ImportResponse[] = []
  attributes: ImportResponse[] = []
  roles: ImportResponse[] = []
  users: ImportResponse[] = []
  lovs: ImportResponse[] = []
}

export interface IItemRelationImportRequest {
  identifier: string
  delete: boolean
  skipActions: boolean
  relationIdentifier: string
  itemIdentifier: string
  targetIdentifier: string
  values: any
}

export interface ITypeImportRequest {
  delete: boolean
  identifier: string
  parentIdentifier: string
  linkIdentifier: string
  name: any
  icon: string
  iconColor: string
  file: boolean
  mainImage: string
  images: [string]
  options: any
}

export interface IRelationImportRequest {
  delete: boolean
  identifier: string
  name: any
  sources: string[]
  targets: string[]
  child: boolean
  multi: boolean
  options: any
}

export interface IAttrGroupImportRequest {
  delete: boolean
  identifier: string
  name: any
  order: number
  visible: boolean
  options: any
}

export interface IAttributeImportRequest {
  delete: boolean
  identifier: string
  name: any
  valid: [string]
  visible: [string]
  relations: [string]
  order: number
  languageDependent: boolean
  groups: [string]
  type: number
  pattern: string
  errorMessage: any
  lov: string
  richText: boolean
  multiLine: boolean
  options: any
}

export interface IRoleImportRequest {
  delete: boolean
  identifier: string
  name: string
  configAccess: IConfigAccessRequest
  relAccess: IRelAccessRequest
  itemAccess: IItemAccessRequest 
  otherAccess: IOtherAccessRequest 
  options: any
}

export interface IConfigAccessRequest {
  lovs: number
  roles: number
  types: number
  users: number
  languages: number
  relations: number
  attributes: number
}

export interface IRelAccessRequest {
  access: number
  relations: [string]
  groups: [IGroupsAccessRequest]
}

export interface IGroupsAccessRequest {
  access: number
  groupIdentifier: string
}

export interface IItemAccessRequest {
  access: number
  valid: [string]
  groups: [IGroupsAccessRequest]
  fromItems: [string]
}

export interface IUserImportRequest {
  delete: boolean
  login: string
  name: string
  roles: [string]
  email: string
  props: any
  options: any
}

export interface IOtherAccessRequest {
  audit: boolean
  search: boolean
  exportXLS: boolean
  exportCSV: boolean
  importXLS: boolean
}

export interface ILOVImportRequest {
  delete: boolean
  identifier: string
  name: any
  values: any
}

