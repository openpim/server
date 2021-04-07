import Context, { ConfigAccess } from '../context'
import { ModelManager, ModelsManager } from '../models/manager'
import { Language } from '../models/languages'
import { sequelize } from '../models'
import audit from '../audit'

export default {
    Query: {
        getItemHistory: async (parent: any, { id, offset, limit, order  }: any, context: Context) => {
            context.checkAuth()
            return audit.getItemHistory(id, offset, limit, order)
        }
    }
}