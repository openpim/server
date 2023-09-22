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
        callback: async (parent: any, { id, uri, rederectURI }: any, context: Context) => {
            const serverConfig = ModelManager.getServerConfig().auth.find((obj: { id: any }) => obj.id === id)
            const issuer = await Issuer.discover(serverConfig.IssuerURL)

            const client: Client = new issuer.Client({
                client_id: serverConfig.CLIENT_ID,
                client_secret: serverConfig.CLIENT_SECRET,
                redirect_uris: [uri + '/openid'],
                response_types: ['code']
            })
            const params  = client.callbackParams(uri)
            params.client_id = serverConfig.CLIENT_ID
            params.client_secret = serverConfig.CLIENT_SECRET
            params.grant_type = 'authorization_code';
            const tokenSet = await client.callback(rederectURI, params)
            const userinfo = await client.userinfo(tokenSet)
            let user = await User.findOne({
                where: { login: userinfo.email }
            })
            if (!user) {
                // create external user on the fly
                const mng = ModelsManager.getInstance().getModelManager('default')
                const userRoles : any = []
                user = await sequelize.transaction(async (t) => {
                    const user = await User.create({
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
                        }, {transaction: t});
                    return user
                })
                mng.getUsers().push(new UserWrapper(user, userRoles))
            }
            const tst = user.options.find((elem:any) => elem.name === 'expiresIn')
            const expiresIn = tst ? tst.value : '1d'
            const token = await jwt.sign({
                id: user.id, 
                tenantId: user.tenantId, 
                login: user.login }, 
                <string>process.env.SECRET, { expiresIn: expiresIn }
            );            

            (<any>user).internalId = user.id

            logger.info("User " + userinfo.email + " was logged on.")

            return {token, user, auditEnabled: audit.auditEnabled()}
        },
    }
}