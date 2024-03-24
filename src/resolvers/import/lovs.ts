import Context from "../../context"
import { IImportConfig, ImportResponse, ReturnMessage, ImportResult, ImportMode, ILOVImportRequest } from "../../models/import"
import { sequelize } from "../../models"
import { LOV } from "../../models/lovs"
import { Attribute } from "../../models/attributes"

import logger from '../../logger'
import { EventType } from "../../models/actions"
import { processLOVActions } from "../utils"

export async function importLOV(context: Context, config: IImportConfig, lov: ILOVImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(lov.identifier)

    if (!lov.identifier || !/^[A-Za-z0-9_-]*$/.test(lov.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        const data = await LOV.applyScope(context).findOne({where: { identifier: lov.identifier }})
        if (lov.delete) {
            if (!data) {
                result.addError(ReturnMessage.LOVNotFound)
                result.result = ImportResult.REJECTED
            } else {

                // check Attributes
                const tst1 = await Attribute.applyScope(context).findOne({where: {lov: data.id}})
                if (tst1) {
                    result.addError(ReturnMessage.LOVDeleteFailed)
                    result.result = ImportResult.REJECTED
                    return result
                }

                await processLOVActions(context, EventType.BeforeDelete, data, true)

                data.updatedBy = context.getCurrentUser()!.login
                // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
                data.identifier = data.identifier + '_d_' + Date.now() 
                await sequelize.transaction(async (t) => {
                    await data.save({transaction: t})
                    await data.destroy({transaction: t})
                })

                await processLOVActions(context, EventType.AfterDelete, data, true)
                
                result.result = ImportResult.DELETED
            }
            return result
        }

        if (config.mode === ImportMode.CREATE_ONLY) {
            if (data) {
                result.addError(ReturnMessage.LOVExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (!data) {
                result.addError(ReturnMessage.LOVNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (!data) {
            // create
            const data = await LOV.build({
                identifier: lov.identifier,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
                name: lov.name,
                values: lov.values || []
            })

            await processLOVActions(context, EventType.BeforeCreate, data, true)

            await sequelize.transaction(async (t) => {
                return await data.save({transaction: t})
            })

            await processLOVActions(context, EventType.AfterCreate, data, true)

            result.id = ""+data.id
            result.result = ImportResult.CREATED
        } else {
            // update

            const changes = {
                name: lov.name,
                values: lov.values
            }
            await processLOVActions(context, EventType.BeforeUpdate, data, true, changes)            

            if (lov.name) data.name = lov.name
            if (lov.values) data.values = lov.values
            data.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await data.save({transaction: t})
            })

            await processLOVActions(context, EventType.AfterUpdate, data, true)

            result.id = ""+data.id
            result.result = ImportResult.UPDATED
        } 
    } catch (error) {
        result.addError(new ReturnMessage(0, ""+error))
        result.result = ImportResult.REJECTED
        logger.error(error)
    }

    return result
}
