import Context from "../../context"
import logger from "../../logger"

export function updateChannelMappings(context: Context, chan: any, mappings: any, conflictedCategories: string[]) {
    const tmp = { ...chan.mappings, ...mappings } // merge mappings to avoid deletion from another user
    for (const prop in mappings) {
        if (mappings[prop].deleted) {
            delete tmp[prop]             
        } else if (chan.type === 2 || chan.type === 3) { // WB || Ozon
            if (typeof mappings[prop] === 'object' && mappings[prop] !== null) {
                const newMapping = mappings[prop]
                const oldMapping = chan.mappings[prop]
                if (newMapping.changed) {
                    delete newMapping.changed
                    if (oldMapping && (!oldMapping.updatedAt || oldMapping.updatedAt < newMapping.readingTime)) {
                        delete newMapping.readingTime
                        if (JSON.stringify(oldMapping) !== JSON.stringify(newMapping)) {
                            tmp[prop] = {
                                ...newMapping,
                                updatedAt: new Date().toISOString(),
                                updatedBy: context.getCurrentUser()!.login
                            }
                        }
                    } else {
                        delete newMapping.readingTime
                        if (oldMapping) {
                            logger.info(`The following categories could not be updated due to conflicts: ${oldMapping.name}`)
                            logger.info(`updatedAt -> ${oldMapping.updatedAt}`)
                            logger.info(`readingTime -> ${newMapping.readingTime}`)
                            logger.info(`oldMapping -> ${JSON.stringify(oldMapping)}`)
                            logger.info(`newMapping -> ${JSON.stringify(newMapping)}`)
                            if (!process.env.NO_MAPPING_ERROR) conflictedCategories.push(oldMapping.name)
                            tmp[prop] = oldMapping
                        } else {
                            tmp[prop] = {
                                ...newMapping,
                                updatedAt: new Date().toISOString(),
                                updatedBy: context.getCurrentUser()!.login
                            }
                        }
                    }
                } else {
                    tmp[prop] = oldMapping
                }
            }
        }
    }
    return tmp
}
