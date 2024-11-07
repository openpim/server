import Context from '../context'
import logger from '../logger'
import { Relation } from '../models/relations'
import { Action } from '../models/actions'
import { Channel } from '../models/channels'
import { Dashboard } from '../models/dashboards'
import { ImportConfig } from '../models/importConfigs'
import { Language } from '../models/languages'
import { AttrGroupWrapper, UserWrapper, ModelsManager, TreeNode } from '../models/manager'
import { AttrGroup, Attribute } from '../models/attributes'
import { Role, User } from '../models/users'
import { Type } from '../models/types'
import { ChannelsManagerFactory } from '../channels'

export default {
  // TODO: should be mutation?
  Query: {
    reloadModelRemotely: async (parent: any, { id, parentId, serverUuid, entity, del }: any, context: Context) => {
      context.checkAuth()
      // we don't need to reload current server
      if (ModelsManager.getInstance().getServerUuid() === serverUuid) {
        logger.debug(`Received reload request for itself, skip it. ${serverUuid}`)
        return
      }
      const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
      try {
        switch (entity) {
          case 'ACTION':
            const existedActions = mng.getActions()
            const actionIndex = existedActions.findIndex(act => act.id === parseInt(id))
            const action = actionIndex !== -1 ? existedActions[actionIndex] : null
            if (del && actionIndex !== -1) {
              existedActions.splice(actionIndex, 1)
              logger.debug(`Remote reload: action removed ${id}`)
            } else {
              // there is now applyscope method in actons???
              // const act = await Action.applyScope(context).findOne({ where: { id } })
              const act = await Action.applyScope(context).findOne({ where: { id } })
              if (act && actionIndex !== -1) {
                existedActions[actionIndex] = act
                logger.debug('Remote reload: action updated')
                logger.debug(JSON.stringify(existedActions[actionIndex]))
              } else if (act && actionIndex === -1) {
                existedActions.push(act)
                logger.debug('Remote reload:: action added')
                logger.debug(JSON.stringify(act))
              }
            }
            if (action) delete mng.getActionsCache()[action.identifier]
            break
          case 'ATTRIBUTE':
            const existedAttr = mng.getAttribute(parseInt(id))
            const grpIndex = mng.getAttrGroups().findIndex(el => el.getGroup().id === parseInt(parentId))
            const existedGroup = mng.getAttrGroups()[grpIndex]
            const relAttributes = mng.getRelationAttributes()
            if (existedAttr && del) {
              const attrIndex = existedGroup.getAttributes().findIndex(el => el.id === id)
              existedGroup.getAttributes().splice(attrIndex, 1)
              if (existedAttr.attr.type === 9) {
                const idx = relAttributes.findIndex((attr) => { return attr.id === existedAttr.attr.id })
                if (idx !== -1) {
                    relAttributes.splice(idx, 1)
                }
              }
              logger.debug(`Remote reload: attribute removed ${id}`)
            } else {
              const attr = await Attribute.applyScope(context).findOne({ where: { id } })
              if (existedAttr && attr) {
                const attrIndex = existedGroup.getAttributes().findIndex(el => el.id === id)
                existedGroup.getAttributes()[attrIndex] = attr
                if (existedAttr.attr.type === 9) {
                  const idx = relAttributes.findIndex((attr) => { return attr.id === existedAttr.attr.id })
                  if (idx !== -1) {
                      relAttributes[idx] = attr
                  }
                }
                logger.debug('Remote reload: attribute updated')
                logger.debug(JSON.stringify(existedGroup.getAttributes()[attrIndex]))
              } else if (!existedAttr && attr) {
                existedGroup.getAttributes().push(attr)
                relAttributes.push(attr)
                logger.debug('Remote reload: attribute added')
                logger.debug(JSON.stringify(attr))
              }
            }
            break
          case 'ATTRIBUTE_GROUP':
            const existedAttrGroups = mng.getAttrGroups()
            const attrGroupIndex = existedAttrGroups.findIndex(attrGroupWrapper => attrGroupWrapper.getGroup().id === parseInt(id))
            if (del && attrGroupIndex !== -1) {
              existedAttrGroups.splice(attrGroupIndex, 1)
              logger.debug(`Remote reload: attribute group removed ${id}`)
            } else {
              const attrGroup = await AttrGroup.applyScope(context).findOne({ where: { id }, include: [{ model: Attribute }] })
              if (attrGroup && attrGroupIndex !== -1) {
                existedAttrGroups[attrGroupIndex] = new AttrGroupWrapper(attrGroup, await attrGroup.getAttributes())
                logger.debug('Remote reload: attribute group updated')
                logger.debug(JSON.stringify(existedAttrGroups[attrGroupIndex]))
              } else if (attrGroup && attrGroupIndex === -1) {
                existedAttrGroups.push(new AttrGroupWrapper(attrGroup, await attrGroup.getAttributes()))
                logger.debug('Remote reload: attribute group added')
                logger.debug(JSON.stringify(attrGroup))
              }
            }
            break
          case 'CHANNEL':
            const existedChannels = mng.getChannels()
            const channelIndex = existedChannels.findIndex(channel => channel.id === parseInt(id))
            if (del && channelIndex !== -1) {
              existedChannels.splice(channelIndex, 1)
              logger.debug(`Remote reload: channel removed ${id}`)
            } else {
              const channel = await Channel.applyScope(context).findOne({ where: { id } })
              if (channel && channelIndex !== -1) {
                existedChannels[channelIndex] = channel
                logger.debug('Remote reload: channel updated')
                logger.debug(JSON.stringify(existedChannels[channelIndex]))
                ChannelsManagerFactory.getInstance().getChannelsManager(context.getCurrentUser()!.tenantId).startChannel(channel)
              } else if (channel && channelIndex === -1) {
                existedChannels.push(channel)
                logger.debug('Remote reload: channel added')
                logger.debug(JSON.stringify(channel))
                ChannelsManagerFactory.getInstance().getChannelsManager(context.getCurrentUser()!.tenantId).startChannel(channel)
              }
            }
            break
          case 'DASHBOARD':
            const existedDashboards = mng.getDashboards()
            const dashboardIndex = existedDashboards.findIndex(dashboard => dashboard.id === parseInt(id))
            if (del && dashboardIndex !== -1) {
              existedDashboards.splice(dashboardIndex, 1)
              logger.debug(`Remote reload: dashboard removed ${id}`)
            } else {
              // there is now applyscope method in dashboards???
              // const act = await Action.applyScope(context).findOne({ where: { id } })
              const dashboard = await Dashboard.applyScope(context).findOne({ where: { id } })
              if (dashboard && dashboardIndex !== -1) {
                existedDashboards[dashboardIndex] = dashboard
                logger.debug('Remote reload: dashboard updated')
                logger.debug(JSON.stringify(existedDashboards[dashboardIndex]))
              } else if (dashboard && dashboardIndex === -1) {
                existedDashboards.push(dashboard)
                logger.debug('Remote reload: dashboard added')
                logger.debug(JSON.stringify(dashboard))
              }
            }
            break
          case 'IMPORT_CONFIG':
            const existedImportConfigs = mng.getImportConfigs()
            const importConfigIndex = existedImportConfigs.findIndex(importConfig => importConfig.id === parseInt(id))
            if (del && importConfigIndex !== -1) {
              existedImportConfigs.splice(importConfigIndex, 1)
              logger.debug(`Remote reload: import config removed ${id}`)
            } else {
              const importConfig = await ImportConfig.applyScope(context).findOne({ where: { id } })
              if (importConfig && importConfigIndex !== -1) {
                existedImportConfigs[importConfigIndex] = importConfig
                logger.debug('Remote reload: import config updated')
                logger.debug(JSON.stringify(existedImportConfigs[importConfigIndex]))
              } else if (importConfig && importConfigIndex === -1) {
                existedImportConfigs.push(importConfig)
                logger.debug('Remote reload: import config added')
                logger.debug(JSON.stringify(importConfig))
              }
            }
            break
          case 'LANGUAGE':
            const existedLanguages = mng.getLanguages()
            const lngIndex = existedLanguages.findIndex(lng => lng.id === parseInt(id))
            if (del && lngIndex !== -1) {
              existedLanguages.splice(lngIndex, 1)
              logger.debug(`Remote reload: language removed ${id}`)
            } else {
              const lng = await Language.findOne({ where: { id } })
              if (lng && lngIndex !== -1) {
                existedLanguages[lngIndex] = lng
                logger.debug('Remote reload: language updated')
                logger.debug(JSON.stringify(existedLanguages[lngIndex]))
              } else if (lng && lngIndex === -1) {
                existedLanguages.push(lng)
                logger.debug('Remote reload: language added')
                logger.debug(JSON.stringify(lng))
              }
            }
            break
          case 'RELATION':
            const existedRels = mng.getRelations()
            const relIndex = existedRels.findIndex(rel => rel.id === parseInt(id))
            if (del && relIndex !== -1) {
              existedRels.splice(relIndex, 1)
              logger.debug(`Remote reload: relation removed ${id}`)
            } else {
              const rel = await Relation.applyScope(context).findOne({ where: { id } })
              if (rel && relIndex !== -1) {
                existedRels[relIndex] = rel
                logger.debug('Remote reload: relation updated')
                logger.debug(JSON.stringify(existedRels[relIndex]))
              } else if (rel && relIndex === -1) {
                existedRels.push(rel)
                logger.debug('Remote reload: relation added')
                logger.debug(JSON.stringify(rel))
              }
            }
            break
          case 'ROLE':
            const existedRoles = mng.getRoles()
            const roleIndex = existedRoles.findIndex(role => role.id === parseInt(id))
            if (del && roleIndex !== -1) {
              existedRoles.splice(roleIndex, 1)
              mng.getUsers().forEach(wrapper => {
                const idx = wrapper.getRoles().findIndex(data => data.id === id)
                if (idx !== -1) wrapper.getRoles().splice(idx, 1)
              })
              logger.debug(`Remote reload: role removed ${id}`)
            } else {
              const role = await Role.applyScope(context).findOne({ where: { id } })
              if (role && roleIndex !== -1) {
                (<any>role).internalId = role.id
                existedRoles[roleIndex] = role
                logger.debug('Remote reload: role updated')
                logger.debug(JSON.stringify(existedRoles[roleIndex]))
              } else if (role && roleIndex === -1) {
                (<any>role).internalId = role.id
                existedRoles.push(role)
                logger.debug('Remote reload: role added')
                logger.debug(JSON.stringify(role))
              }
            }
            break
          case 'TYPE': {
            let typeNode = mng.getTypeById(parseInt(id))
            if (del && typeNode) {
              const parentNode = typeNode.getParent()!
              if (parentNode.getValue()) {
                parentNode.deleteChild(typeNode)
              } else {
                mng.getRoot().deleteChild(typeNode)
              }
            } else {
              const typeFromDB = await Type.applyScope(context).findOne({ where: { id } })
              if (!typeNode && typeFromDB) {
                mng.addType(parseInt(parentId), typeFromDB)
              } else {
                const types: Type[] = await Type.findAll({
                  order: [['tenantId', 'DESC'], ['path', 'ASC']]
                })

                let currentNode: TreeNode<any> = mng.resetRoot()
                let currentLevel: number = 1
                types.forEach((type) => {
                  const arr = type.path.split('.')
                  if (currentLevel > arr.length) {
                    while (currentLevel > arr.length) {
                      currentNode = currentNode.getParent()!
                      currentLevel--
                    }
                  }
                  const node = new TreeNode<Type>(type, currentNode)
                  currentNode.getChildren().push(node)
                  currentNode = node
                  currentLevel++
                })
              }
            }
            logger.debug('Remote reload: types reloaded')
            break
          }
          case 'USER':
            const existedUsers = mng.getUsers()
            const userIndex = existedUsers.findIndex(user => user.getUser().id === parseInt(id))
            if (del && userIndex !== -1) {
              existedUsers.splice(userIndex, 1)
              logger.debug(`Remote reload: user removed ${id}`)
            } else {
              const user = await User.applyScope(context).findOne({ where: { id } })
              const userRoles = user && user.roles ? user.roles.map((roleId: number) => mng!.getRoles().find(role => role.id === roleId)) : []
              if (user && userIndex != -1) {
                (<any>user).internalId = user.id
                existedUsers[userIndex] = new UserWrapper(user, userRoles)
                logger.debug('Remote reload: user updated')
                logger.debug(JSON.stringify(existedUsers[userIndex]))
              } else if (user && userIndex === -1) {
                (<any>user).internalId = user.id
                existedUsers.push(new UserWrapper(user, userRoles))
                logger.debug('Remote reload: user added')
                logger.debug(JSON.stringify(user))
              }
            }
            break
        }
        return true
      } catch (e) {
        logger.error(`Can not reload model`)
        logger.error(e)
        return false
      }
    }
  }
}