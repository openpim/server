import Context from "../../context"

export function updateChannelMappings(context: Context, chan: any, mappings: any, conflictedCategories: string[]) {
    const tmp = { ...chan.mappings }
    const tracked = [2, 3, 9].includes(chan.type)
    for (const prop of Object.keys(mappings)) {
        if (['__proto__', 'constructor', 'prototype'].includes(prop)) throw new Error('Invalid mapping key.')
        const draft = mappings[prop]
        if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Invalid channel mapping.')
        const oldMapping = chan.mappings?.[prop]
        const versioned = Object.prototype.hasOwnProperty.call(draft, '_expectedUpdatedAt')
        const checked = tracked && (prop !== '_default' || versioned)
        // Unmarked legacy Yandex clients retain their original SAVE contract.
        if (checked && !draft.deleted && !draft.changed && (versioned || chan.type !== 9)) continue
        const conflict = checked && (versioned
            ? (oldMapping?.updatedAt || null) !== draft._expectedUpdatedAt
            : !!oldMapping?.updatedAt && (!draft.readingTime || oldMapping.updatedAt >= draft.readingTime))
        if (conflict) {
            conflictedCategories.push(String(oldMapping?.name || draft.name || prop))
            continue
        }
        if (draft.deleted) { delete tmp[prop]; continue }
        const clean = JSON.parse(JSON.stringify(draft))
        delete clean.changed
        delete clean.readingTime
        delete clean._savedAIContext
        delete clean._expectedUpdatedAt
        tmp[prop] = checked ? {
            ...clean,
            updatedAt: new Date(Math.max(Date.now(), Date.parse(oldMapping?.updatedAt || '') + 1 || 0)).toISOString(),
            updatedBy: context.getCurrentUser()!.login
        } : clean
    }
    return tmp
}
