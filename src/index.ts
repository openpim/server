import compression from 'compression'
import { makeExecutableSchema } from '@graphql-tools/schema';
import bodyParser from 'body-parser';
import { Buffer } from 'buffer';
import cors from 'cors';
import * as crypto from "crypto";
import * as dotenv from 'dotenv';
import express from 'express';
import { graphqlHTTP } from 'express-graphql';
import { GraphQLError, print } from 'graphql';
import { importSchema } from 'graphql-import';
import { IncomingMessage } from 'http';
import { ChannelsManagerFactory } from './channels';
import Context from './context';
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
import { generateTemplate } from './templates';
import { ModelsManager } from './models/manager';
import resolvers from './resolvers';
import version from './version';

import userResolver from './resolvers/users'
import { FileManager } from './media/FileManager';


let isMetrics
if (process.env.OPENPIM_DATABASE_ADDRESS) process.env.DATABASE_URL = process.env.OPENPIM_DATABASE_ADDRESS
if (process.env.OPENPIM_DATABASE_NAME) process.env.DATABASE_NAME = process.env.OPENPIM_DATABASE_NAME
if (process.env.OPENPIM_DATABASE_PORT) process.env.DATABASE_PORT = process.env.OPENPIM_DATABASE_PORT
if (process.env.OPENPIM_DATABASE_USER) process.env.DATABASE_USER = process.env.OPENPIM_DATABASE_USER
if (process.env.OPENPIM_DATABASE_PASSWORD) process.env.DATABASE_PASSWORD = process.env.OPENPIM_DATABASE_PASSWORD
if (process.env.OPENPIM_AUDIT_URL) process.env.AUDIT_URL = process.env.OPENPIM_AUDIT_URL
if (process.env.OPENPIM_ENABLE_METRICS) isMetrics = process.env.OPENPIM_ENABLE_METRICS === 'true' ? true : false

dotenv.config();
const app = express();
app.use(compression())
app.use(bodyParser.json({limit: '500mb'}));
app.use(i18nextMiddleware.handle(i18next));

(async () => {
  await initModels();
  logger.info(`${i18next.t('Serverversion')}: ${  version.buildMajor  }.${  version.buildMinor  }.${  version.buildRevision}`)
  logger.info(`${i18next.t('Arguments')}: ${  process.argv}`)
  
  // Construct a schema, using GraphQL schema language
  const typeDefs = await importSchema('./schema/index.graphql'); 
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

  ModelsManager.getInstance().init(channelTypes)
  ChannelsManagerFactory.getInstance().init()

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
  
  app.use('/graphql', graphqlHTTP(async (request: IncomingMessage ) => { 
    const ctx = await Context.create(request)
    return {
    schema,
    graphiql: false,
    context: ctx,
    customFormatErrorFn: (error: GraphQLError) => {
      const params = {
        message: error.message
      };
      logger.error('ERROR -', error, error.source);
      logger.error(`   request - ${ JSON.stringify((<any>request).body)}`);
      return (params);
    },
    extensions: ({ document, result }) => {
      if (logger.transports[0].level === 'debug') logger.debug('Request ('+ctx.getCurrentUser()?.login+'):\n'+print(document)+'Response:\n'+JSON.stringify(result)+'\n\n')
      return undefined
    }
  }}));

  app.get('/healthcheck', async (req, res) => {
    res.json({result: "OK"})
  })

  app.post('/asset-upload', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()

      await processUpload(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/xlsx-template-upload', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
	  
      await processUploadXlsxTemplate(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/xlsx-template/:id', async (req, res) => { 
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await downloadXlsxTemplateFile(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/asset-create-upload', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()

      await processCreateUpload(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/mi/:identifier', async (req, res) => {
    try {
      const context = await Context.create(req)
      await processDownloadMain(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      await processDownload(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset/inline/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      await processDownloadInline(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })
  
  app.get('/asset/:id/thumb', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await processDownload(context, req, res, true)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset-channel/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await processChannelDownload(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/process-upload', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()

      await uploadProcessFile(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/import-upload', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await uploadImportFile(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/import-config-test/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await testImportConfig(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.post('/import-config-template-upload', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await uploadImportConfigTemplateFile(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/import-config-template/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await downloadImportConfigTemplateFile(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/import-config-data/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await getImportConfigFileData(context, req, res, false)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset-process/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
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
      const { user } = await userResolver.Mutation.signIn(null, {login: login, password:password }, await Context.create(request))
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
      const context = await Context.create(req)
      await generateTemplate(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  await Context.init()
  app.listen(process.env.PORT);
  logger.info(`${i18next.t('RunningaGraphQLAPIserver')} at http://localhost:${process.env.PORT}/graphql`);
})();