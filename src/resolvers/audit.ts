import Context, { ConfigAccess } from '../context'
import { ModelManager, ModelsManager } from '../models/manager'
import { Language } from '../models/languages'
import { sequelize } from '../models'

export default {
    Query: {
        getHistory: async (parent: any, { id, offset, limit, order  }: any, context: Context) => {
            context.checkAuth()
            return null
        }
    }
}