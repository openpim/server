import Context from "../../context"

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
                            conflictedCategories.push(oldMapping.name)
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
