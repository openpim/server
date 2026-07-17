import compression from 'compression'
import { makeExecutableSchema } from '@graphql-tools/schema';
import bodyParser from 'body-parser';
import { Buffer } from 'buffer';
import cors from 'cors';
import * as crypto from "crypto";
import * as dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { createHandler } from 'graphql-http/lib/use/express';
import { ExecutionResult, GraphQLError, print } from 'graphql';
import { ChannelsManagerFactory } from './channels';
import { ChannelExecution } from './models/channels'
import Context from './context';
import { getGraphQLErrorStatus } from './graphql/errors';
import { loadSchemaTypeDefs } from './graphql/schemaLoader';
import logger from './logger';
import i18next from './i18n';
import i18nextMiddleware from 'i18next-express-middleware';
import { 
  processChannelDownload, 
  processCreateUpload, 
  processDownload, 
  processUpload, 
  processDownloadMain, 
  uploadProcessFile, 
  downloadProcessFile, 
  uploadImportFile, 
  uploadImportConfigTemplateFile, 
  downloadImportConfigTemplateFile, 
  getImportConfigFileData, 
  testImportConfig,
  processUploadXlsxTemplate, 
  downloadXlsxTemplateFile,
  processDownloadInline,
  uploadStaticImage,
  handleBulkUpload,
  handleBulkStart,
} from './media';
import { initModels } from './models';
import { 
  renderSQLMetrics, 
  db_average_query_time_ms, 
  db_query_time_counter05, 
  db_query_time_counter1, 
  db_query_time_counter3, 
  db_query_time_counter5, 
  db_query_time_counter10, 
  db_query_time_counterInf, 
  metricsMiddleware 
} from './metrics'
import { generateTemplate, generateTemplateForItems } from './templates';
import { ModelsManager } from './models/manager';
import resolvers from './resolvers';
import version from './version';

import userResolver from './resolvers/users'
import { FileManager } from './media/FileManager';
import { v2 as webdav } from 'webdav-server'
import fs from 'fs'
import { StorageFactory } from './storage/StorageFactory';

let isMetrics
if (process.env.OPENPIM_DATABASE_ADDRESS) process.env.DATABASE_URL = process.env.OPENPIM_DATABASE_ADDRESS
if (process.env.OPENPIM_DATABASE_NAME) process.env.DATABASE_NAME = process.env.OPENPIM_DATABASE_NAME
if (process.env.OPENPIM_DATABASE_PORT) process.env.DATABASE_PORT = process.env.OPENPIM_DATABASE_PORT
if (process.env.OPENPIM_DATABASE_USER) process.env.DATABASE_USER = process.env.OPENPIM_DATABASE_USER
if (process.env.OPENPIM_DATABASE_PASSWORD) process.env.DATABASE_PASSWORD = process.env.OPENPIM_DATABASE_PASSWORD
if (process.env.OPENPIM_AUDIT_URL) process.env.AUDIT_URL = process.env.OPENPIM_AUDIT_URL
if (process.env.OPENPIM_ENABLE_METRICS) isMetrics = process.env.OPENPIM_ENABLE_METRICS === 'true' ? true : false

const app = express();

export let isWebDAVEnabled = false
export function setWebDAVEnabled(v: boolean) {
  isWebDAVEnabled = v
}

app.use(compression())
app.use(bodyParser.json({limit: '500mb'}));
app.use(i18nextMiddleware.handle(i18next));

(async () => {
  await initModels();
  logger.info(`${i18next.t('Serverversion')}: ${  version.buildMajor  }.${  version.buildMinor  }.${  version.buildRevision}`)
  logger.info(`${i18next.t('Arguments')}: ${  process.argv}`)
  StorageFactory.getStorageInstance()
  
  // Construct a schema, using GraphQL schema language
  const typeDefs = await loadSchemaTypeDefs('./schema/index.graphql'); 
  const schema = await makeExecutableSchema({ typeDefs, resolvers })

  let channelTypes = undefined
  
  if (process.env.OPENPIM_KEY) {
    const keyData = 
`-----BEGIN RSA PUBLIC KEY-----
MEgCQQDG0oEGhlYcN12BqBeMn9aRwfrPElOol7prVUQNAggZjurOQ5DyjbPh9uOW
XWhRphP+pl2nJQLVRu+oDpf2wKc/AgMBAAE=
-----END RSA PUBLIC KEY-----
`
    const publicKey: crypto.KeyObject = crypto.createPublicKey({key: keyData, type: 'pkcs1', format: 'pem'})
    const str = Buffer.from(process.env.OPENPIM_KEY, 'base64').toString('ascii')
    const idx = str.lastIndexOf('|')
    const sign = str.substring(idx+1)
    const data = str.substring(0, idx)
    const split = data.split('|')
    const options: any = { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }
    const isVerified = crypto.verify( "sha256", Buffer.from(data), options, Buffer.from(sign, 'base64'))
    if (isVerified) {
      channelTypes = JSON.parse("[" + split[0] + "]")
      logger.info(`Found key for company: ${split[1]} with data: ${channelTypes}`)
    } else {
      logger.error(`${i18next.t('WrongKey')}`)
      channelTypes = []
    }
  }

  if (isMetrics) {
    app.use((req, res, next) => {
      db_average_query_time_ms
      db_query_time_counter05
      db_query_time_counter1
      db_query_time_counter3
      db_query_time_counter5
      db_query_time_counter10
      db_query_time_counterInf
      next()
    })
    app.use(metricsMiddleware)
  }

  await ModelsManager.getInstance().init(channelTypes)
  ChannelsManagerFactory.getInstance().init()

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());

  const resolveAcceptedGraphQLContentType = (request: any) => {
    const acceptHeader = typeof request.headers.accept === 'string' ? request.headers.accept.toLowerCase() : ''
    if (acceptHeader.includes('application/graphql-response+json')) {
      return 'application/graphql-response+json; charset=utf-8'
    }
    return 'application/json; charset=utf-8'
  }

  const serializeGraphQLResult = (result: ExecutionResult, errorFormatter: (error: Readonly<GraphQLError | Error>) => GraphQLError | Error) => {
    return JSON.stringify(
      result.errors ? { ...result, errors: result.errors.map(errorFormatter) } : result
    )
  }

  app.all('/graphql', async (request:any, response:any) => {
    let ctx: Context | null = null
    try {
      ctx = await Context.create(request, response)
    } catch (e) {
      response.status(401).json({errors:[{message:"Your session expired. Sign in again."}]})
      return
    }

    const formatGraphQLError = (error: Readonly<GraphQLError | Error>) => {
      logger.error('GraphQL error', error)
      logger.error(`GraphQL request payload: ${JSON.stringify(request.body ?? null)}`)
      return error
    }

    const process = createHandler<any>({
      schema,
      context: (req: any, params: any) => {
        ;(req.raw as any).graphqlParams = params
        return ctx as Context
      },
      formatError: formatGraphQLError,
      onOperation: (req, args, result) => {
        const requestText = print(args.document)
        const responseText = JSON.stringify(result)
        const userLogin = ctx?.getCurrentUser()?.login || 'anonymous'
        const hasDebugLogging = logger.transports[0].level === 'debug'

        if (hasDebugLogging) {
          logger.debug(`Request (${userLogin}):\n${requestText}\nResponse:\n${responseText}\n`)
        }

        if (result.errors?.length) {
          logger.error(`GraphQL request failed (${userLogin}):\n${requestText}`)
          result.errors.forEach((error) => logger.error('GraphQL execution error', error))

          const errorStatuses = result.errors
            .map((error) => getGraphQLErrorStatus(error))
          const authStatus = errorStatuses.find((status) => status === 401)

          if (authStatus) {
            return [
              serializeGraphQLResult(result, formatGraphQLError),
              {
                status: authStatus,
                statusText: 'Unauthorized',
                headers: {
                  'content-type': resolveAcceptedGraphQLContentType(request),
                },
              },
            ] as const
          }

          const hasCustomHttpStatus = errorStatuses.some((status) => typeof status === 'number')

          if (!hasCustomHttpStatus) {
            return [
              serializeGraphQLResult(result, formatGraphQLError),
              {
                status: 500,
                statusText: 'Internal Server Error',
                headers: {
                  'content-type': resolveAcceptedGraphQLContentType(request),
                },
              },
            ] as const
          }
        }

        return result
      },
    })

    await process(request, response, () => undefined)
  });

  app.get('/healthcheck', async (req, res) => {
    res.json({result: "OK"})
  })

  app.post('/asset-upload', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()

      await processUpload(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/xlsx-template-upload', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
	  
      await processUploadXlsxTemplate(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/xlsx-template/:id', async (req, res) => { 
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await downloadXlsxTemplateFile(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/asset-create-upload', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()

      await processCreateUpload(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/mi/:identifier', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      await processDownloadMain(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      await processDownload(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset/inline/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      await processDownloadInline(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })
  
  app.get('/asset/:id/thumb', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await processDownload(context, req, res, true)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset-channel/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await processChannelDownload(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/process-upload', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()

      await uploadProcessFile(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/import-upload', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await uploadImportFile(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })


  app.post('/bulk-upload', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await handleBulkUpload(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/bulk-upload/start/:processId', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await handleBulkStart(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })
  
  app.post('/import-config-test/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await testImportConfig(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/import-config-template-upload', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await uploadImportConfigTemplateFile(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/image-upload', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await uploadStaticImage(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/import-config-template/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await downloadImportConfigTemplateFile(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/import-config-data/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await getImportConfigFileData(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset-process/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      await downloadProcessFile(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/server.log', async (request, response) => {
    try {
      if (!request.headers.authorization) {
        logger.error('server.log - no login')
        response.set('WWW-Authenticate', 'Basic realm="401"')
        response.status(401).send('Authentication required.')
        return
      }
      const b64auth = request.headers.authorization.split(' ')[1]
      const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')
      const { user } = await userResolver.Mutation.signIn(null, {login: login, password:password }, await Context.create(request, response))
      if (user && user.roles.includes(1)) { // 1 is admin role
        let bufSize = 10240
        if (request.query.size) {
          const sizeStr = ''+request.query.size
          const sizeNum = parseInt(sizeStr)
          if (!isNaN(sizeNum)) bufSize = sizeNum
        }
        const buf = await FileManager.getLastXBytesBuffer('/server/server.log', bufSize)
        response.setHeader('Content-Type', 'text/plain');
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Expires', '0');
        response.setHeader('Surrogate-Control', 'no-store');
        response.status(200).send(buf.toString());
      } else {
        logger.error('server.log - wrong user: '+JSON.stringify(user))
        response.set('WWW-Authenticate', 'Basic realm="401"')
        response.status(401).send('Authentication required.')
        return
      }
    } catch (error: any) {
      response.status(400).send(error.message)
    }
  })

  app.get('/sqlmetrics', async (request, response) => {
    await renderSQLMetrics(request, response)
  })

  app.get('/template/:template_id/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      await generateTemplate(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/templateforitems', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      await generateTemplateForItems(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

    app.get('/execution_log/:id', async (req, res) => {
    try {
      const context = await Context.create(req, res)
      context.checkAuth()
      const { id } = req.params
      const execution = await ChannelExecution.findOne({
        where: { id }
      })
      if (!execution || !execution.log) {
        res.status(404).send('Log not found')
        return
      }

      const logText = execution.log

      res.setHeader('Content-Disposition', `attachment; filename=log_${id}.txt`)
      res.setHeader('Content-Type', 'text/plain')
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
      res.setHeader('Surrogate-Control', 'no-store')
      res.status(200).send(logText)
    } catch (error: any) {
      console.error(error)
      res.status(400).send(error.message)
    }
  })

  const fsRoot = process.env.FILES_ROOT

  const webDavServer = new webdav.WebDAVServer()
  if (fsRoot) {
    webDavServer.setFileSystem('/', new webdav.PhysicalFileSystem(fsRoot), () => { })
  }

  webDavServer.httpAuthentication = {
    askForAuthentication() {
      return { 'WWW-Authenticate': 'Basic realm="WebDAV"' }
    },
    getUser(ctx, cb) {
      const user = { uid: 'test', username: 'test' }
      if (typeof cb === 'function') cb(null as unknown as Error, user)
      return user
    }
  }

  app.use('/webdav', async (req, res) => {
    try {
      if (!req.headers.authorization) {
        logger.error('[WebDAV] Нет заголовка авторизации')
        res.set('WWW-Authenticate', 'Basic realm="WebDAV"')
        res.status(401).send('Authentication required.')
        return
      }

      const b64auth = req.headers.authorization.split(' ')[1]
      const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')

      const { user } = await userResolver.Mutation.signIn(null, { login, password }, await Context.create(req, res))
      if (!user || !user.roles.includes(1)) {
        logger.warn('[WebDAV] Неверные логин/пароль или нет прав')
        res.set('WWW-Authenticate', 'Basic realm="WebDAV"')
        res.status(401).send('Authorization required')
        return
      }

      if (!isWebDAVEnabled) {
        res.status(503).send('WebDAV временно отключён')
        return
      }

      if (!fsRoot) {
        logger.error('[WebDAV] Не задан FILES_ROOT')
        res.status(500).send('WebDAV не сконфигурирован (FILES_ROOT не задан)')
        return
      }

      logger.info(`[WebDAV] ${req.method} ${req.url}`)

      try {
        fs.accessSync(fsRoot, fs.constants.R_OK | fs.constants.W_OK)
        logger.info('[WebDAV] Доступ к папке ok')
      } catch (err) {
        logger.warn('[WebDAV] Нет прав на папку', err)
        res.status(500).end('Нет прав на доступ к папке WebDAV')
        return
      }

      try {
        webDavServer.executeRequest(req, res)
      } catch (err) {
        logger.error('[WebDAV] Ошибка executeRequest', err)
        res.status(500).end('WebDAV internal error')
      }
    } catch (error: any) {
      logger.error('[WebDAV] Ошибка:', error)
      res.status(400).send(error.message)
    }
  })

  await Context.init()
  app.listen(process.env.PORT);
  logger.info(`${i18next.t('RunningaGraphQLAPIserver')} at http://localhost:${process.env.PORT}/graphql`);
})();
