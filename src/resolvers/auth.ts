import Context from '../context'
import * as jwt from 'jsonwebtoken';
import { User } from '../models/users'
import { sequelize } from '../models'
import { Issuer, Client } from 'openid-client'

import logger from '../logger'
import audit from '../audit'
import { ModelsManager, ModelManager, UserWrapper } from '../models/manager';

export default {
    Query: {
        auth: async (parent: any, { id, uri }: any, context: Context) => {
            const serverConfig = ModelManager.getServerConfig().auth.find((obj: { id: any }) => obj.id === id)
            const issuer = await Issuer.discover(serverConfig.IssuerURL)

            const client: Client = new issuer.Client({
                client_id: serverConfig.CLIENT_ID,
                client_secret: serverConfig.CLIENT_SECRET,
                redirect_uris: [uri + '/openid.html'],
                response_types: ['code']
            });

            const authorizationUrl = client.authorizationUrl({
                scope: 'openid profile email'
            });
            return authorizationUrl
        },
        callback: async (parent: any, { id, uri, redirectURI }: any, context: Context) => {
            const serverConfig = ModelManager.getServerConfig().auth.find((obj: { id: any }) => obj.id === id)
            const issuer = await Issuer.discover(serverConfig.IssuerURL)

            const client: Client = new issuer.Client({
                client_id: serverConfig.CLIENT_ID,
                client_secret: serverConfig.CLIENT_SECRET,
                redirect_uris: [uri + '/openid'],
                response_types: ['code']
            })
            const params = client.callbackParams(uri)
            params.client_id = serverConfig.CLIENT_ID
            params.client_secret = serverConfig.CLIENT_SECRET
            params.grant_type = 'authorization_code'

            const tokenSet = await client.callback(redirectURI, params)
            const userinfo = await client.userinfo(tokenSet)
            logger.debug(`tokenSet - ${JSON.stringify(tokenSet)}`)
            logger.debug(`userinfo - ${JSON.stringify(userinfo)}`)

            let user = await User.findOne({ where: { login: userinfo.email } })

            const mng = ModelsManager.getInstance().getModelManager(serverConfig.tenantId)

            const resolveUserRoles = () => (Array.isArray(userinfo.group) ? userinfo.group : [])
                .map((role: string) =>
                    mng.getRoles().find((elem: any) =>
                        elem.options.some((opt: any) => opt.name === 'openid' && opt.value === role)
                    )
                )
                .filter((role): role is any => role !== undefined)

            if (!user) {
                // create external user on the fly
                user = await sequelize.transaction(async (t) => {
                    const newUser = await User.create({
                        tenantId: serverConfig.tenantId,
                        createdBy: 'system',
                        updatedBy: '',
                        login: userinfo.email,
                        name: userinfo.name,
                        password: '#external#',
                        email: userinfo.email,
                        roles: serverConfig.roles,
                        props: {},
                        options: []
                    }, { transaction: t })
                    return newUser
                })

                if (serverConfig.rolesMapping) {
                    const userRoles = resolveUserRoles()
                    mng.getUsers().push(new UserWrapper(user, userRoles))
                }
            } else {
                if (serverConfig.rolesMapping) {
                    const userRoles = resolveUserRoles()
                    mng.getUsers().push(new UserWrapper(user, userRoles))
                }
            }

            const tst = user.options.find((elem: any) => elem.name === 'expiresIn')
            const expiresIn = tst ? tst.value : '1d'
            const token = await jwt.sign({
                id: user.id,
                tenantId: user.tenantId,
                login: user.login
            }, <string>process.env.SECRET, { expiresIn });
            
            (<any>user).internalId = user.id

            logger.info("User " + userinfo.email + " was logged on.")

            return { token, user, auditEnabled: audit.auditEnabled(), locale: serverConfig.locale }
        },
    }
}