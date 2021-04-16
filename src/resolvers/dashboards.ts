import Context, { ConfigAccess } from '../context'
import { ModelsManager } from '../models/manager'
import { sequelize } from '../models'
import { Dashboard } from '../models/dashboards'
import { Item } from '../models/items'
import { fn, literal } from 'sequelize'
import { prepareWhere } from './search'
import { LOV } from '../models/lovs'

const golden_ratio_conjugate = 0.618033988749895
function generateColor() {
    // https://stackoverflow.com/questions/1484506/random-color-generator

    let brightness = 2
    // Six levels of brightness from 0 to 5, 0 being the darkest
    var rgb = [Math.random() * 256, Math.random() * 256, Math.random() * 256];
    var mix = [brightness*51, brightness*51, brightness*51]; //51 => 255/5
    var mixedrgb = [rgb[0] + mix[0], rgb[1] + mix[1], rgb[2] + mix[2]].map(function(x){ return Math.round(x/2.0)})
    return "#"+mixedrgb[0].toString(16)+mixedrgb[1].toString(16)+mixedrgb[2].toString(16)

    /*
    // https://martin.ankerl.com/2009/12/09/how-to-create-random-colors-programmatically/
    // https://stackoverflow.com/questions/17242144/javascript-convert-hsb-hsv-color-to-rgb-accurately

    let rand = Math.floor(Math.random() * Math.floor(256))

    // rand += 256*golden_ratio_conjugate
    // rand = 256 % rand
    const rgb = HSVtoRGB(rand, 0.5, 0.95)

    return "#"+rgb.r.toString(16)+rgb.g.toString(16)+rgb.b.toString(16) */
}

function mix(a: number, b: number, v: number)
{
    return (1-v)*a + v*b;
}
function HSVtoRGB(H: number, S: number, V: number)
{
    var V2 = V * (1 - S);
    var r  = ((H>=0 && H<=60) || (H>=300 && H<=360)) ? V : ((H>=120 && H<=240) ? V2 : ((H>=60 && H<=120) ? mix(V,V2,(H-60)/60) : ((H>=240 && H<=300) ? mix(V2,V,(H-240)/60) : 0)));
    var g  = (H>=60 && H<=180) ? V : ((H>=240 && H<=360) ? V2 : ((H>=0 && H<=60) ? mix(V2,V,H/60) : ((H>=180 && H<=240) ? mix(V,V2,(H-180)/60) : 0)));
    var b  = (H>=0 && H<=120) ? V2 : ((H>=180 && H<=300) ? V : ((H>=120 && H<=180) ? mix(V2,V,(H-120)/60) : ((H>=300 && H<=360) ? mix(V,V2,(H-300)/60) : 0)));

    return {
        r : Math.round(r * 255),
        g : Math.round(g * 255),
        b : Math.round(b * 255)
    };
}

export default {
    Query: {
        getDashboards: async (parent: any, args: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.getDashboards()
        },
        getDashboardComponentData: async (parent: any, { dashboardId, componentId }: any, context: Context) => {
            context.checkAuth()

            const ndashboardId = parseInt(dashboardId)
            const ncomponentId = parseInt(componentId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const dash  = mng.getDashboards().find(dash => dash.id === ndashboardId)
            if (!dash) {
                throw new Error('Failed to find dashboard by id: ' + ndashboardId + ', tenant: ' + mng.getTenantId())
            }

            const component = dash.components.find((comp: any) => comp.id === ncomponentId)
            if (!component) {
                throw new Error('Failed to find component by id: ' + ncomponentId + ' in dashboard id: ' + ndashboardId + ', tenant: ' + mng.getTenantId())
            }

            let option = null
            let data: any
            let lov: LOV | null = null
            if (component.type === 1) {
                /* example of request
                const result: any = await Item.applyScope(context).findAll({
                    attributes: [
                        [fn('count', '*'), 'count'],
                        [fn('jsonb_extract_path', literal("values"), literal("'vendor'")), 'attr']
                    ],
                    where: {"typeIdentifier":"item"}, 
                    group: [fn('jsonb_extract_path', literal("values"), literal("'vendor'"))]
                }) */

                // group by
                let groupExpression = null
                if (component.groupBy.startsWith('name#')) {
                    const langIdentifier = component.groupBy.substring(5)
                    groupExpression = fn('jsonb_extract_path', literal("name"), literal("'" + langIdentifier + "'"))
                } else if (component.groupBy.startsWith('attr#')) {
                    const path: string[] = component.groupBy.substring(5).split("#")

                    const attrIdentifier = path[0]
                    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                    const attr = mng.getAttributeByIdentifier(attrIdentifier)?.attr

                    if (attr) {
                        if (attr.lov) {
                            lov = await LOV.applyScope(context).findByPk(attr.lov)
                        }
                    }

                    const literals = path.map(attr => literal("'"+attr+"'"))
                    literals.unshift(literal("values"))
                    groupExpression = fn('jsonb_extract_path', ...literals)
                } else {
                    // usual field
                    groupExpression = component.groupBy
                }

                const options = component.groupWhere ? prepareWhere(context, JSON.parse(component.groupWhere)) : {where: null, include: null}
                const result: any = await Item.applyScope(context).findAll({
                    attributes: [
                        [fn('count', '*'), 'count'],
                        [groupExpression, 'attr']
                    ],
                    where: options.where,
                    include: options.include,
                    group: [groupExpression]
                })

                data = {
                    labels: result.map((record:any) => {
                        const val = record.getDataValue('attr')

                        if (lov) {
                            const tst = lov.values.find((lovItem:any) => lovItem.id == val)
                            return tst ? tst.value.ru : val // now we returned only Russian values... need to know current language from UI, todo later
                        } else {
                            return val
                        }
                    }),
                    datasets: [
                      {
                        label: component.title,
                        data: result.map((record:any) => record.getDataValue('count'))
                      }
                    ]
                }
                if (lov) data.lovValues = lov.values
            } else {
                const labels: string[] = []
                const records: any[] = []

                for(let i = 0; i < component.queries.length; i++) {
                    const query = component.queries[i]

                    labels.push(query.label)

                    const options = query.where ? prepareWhere(context, JSON.parse(query.where)) : {where: null, include: null}
                    if (options.include) {
                        const result: any = await Item.applyScope(context).findAll({
                            where: options.where,
                            include: options.include
                        })
                        records.push(result.length)
                    } else {
                        const result: any = await Item.applyScope(context).findAll({
                            attributes: [
                                [fn('count', '*'), 'count']
                            ],
                            where: options.where
                        })
                        records.push(result[0].getDataValue('count'))
                    }
                }

                data = {
                    labels: labels,
                    datasets: [
                      {
                        label: component.title,
                        data: records
                      }
                    ]
                  } 
            }

            /*
            if (component.chart === 1 || component.chart === 2) {
                // bar and horizontal bar
                data.datasets[0].backgroundColor = generateColor()
            } else {
                // pie and circle
                data.datasets[0].backgroundColor = data.datasets[0].data.map((label:any) => generateColor())
            }*/
            data.datasets[0].backgroundColor = data.datasets[0].data.map((label:any) => generateColor())

            return data

            /*
                const data = {
                    labels: [
                      'January',
                      'February',
                      'March',
                      'April',
                      'May',
                      'June',
                      'July',
                      'August',
                      'September',
                      'October',
                      'November',
                      'December'
                    ],
                    datasets: [
                      {
                        label: component.title,
                        // backgroundColor: '#f87979',
                        data: [40, 20, 12, 39, 10, 40, 39, 80, 40, 20, 12, 11]
                      }
                    ]
                  } 
                  */
        }
    },
    Mutation: {
        createDashboard: async (parent: any, {identifier, name, users, components}: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.DASHBOARDS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create dashboard, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst = mng.getDashboards().find( dash => dash.identifier === identifier)
            if (tst) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const dash = await sequelize.transaction(async (t) => {
                return await Dashboard.create ({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    users: users || [],
                    components: components || []
                }, {transaction: t})
            })

            mng.getDashboards().push(dash)
            return dash.id
        },
        updateDashboard: async (parent: any, { id, name, users, components }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.DASHBOARDS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update dashboard, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let dash  = mng.getDashboards().find(dash => dash.id === nId)
            if (!dash) {
                throw new Error('Failed to find dashboard by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            if (name) dash.name = name
            if (users) dash.users = users
            if (components) dash.components = components
            dash.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await dash!.save({transaction: t})
            })
            return dash.id
        },
        removeDashboard: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.DASHBOARDS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove dashboard, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const idx = mng.getDashboards().findIndex(dash => dash.id === nId)    
            if (idx === -1) {
                throw new Error('Failed to find dashboard by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            const dash  = mng.getDashboards()[idx]
            dash.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            dash.identifier = dash.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await dash!.save({transaction: t})
                await dash!.destroy({transaction: t})
            })

            mng.getDashboards().splice(idx, 1)

            return true
        }
    }
}