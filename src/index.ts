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
import { processChannelDownload, processCreateUpload, processDownload, processUpload, processDownloadMain } from './media';
import { initModels } from './models';
import { ModelsManager } from './models/manager';
import resolvers from './resolvers';
import version from './version';

if (process.env.OPENPIM_DATABASE_ADDRESS) process.env.DATABASE_URL = process.env.OPENPIM_DATABASE_ADDRESS
if (process.env.OPENPIM_DATABASE_NAME) process.env.DATABASE_NAME = process.env.OPENPIM_DATABASE_NAME
if (process.env.OPENPIM_DATABASE_PORT) process.env.DATABASE_PORT = process.env.OPENPIM_DATABASE_PORT
if (process.env.OPENPIM_DATABASE_USER) process.env.DATABASE_USER = process.env.OPENPIM_DATABASE_USER
if (process.env.OPENPIM_DATABASE_PASSWORD) process.env.DATABASE_PASSWORD = process.env.OPENPIM_DATABASE_PASSWORD
if (process.env.OPENPIM_AUDIT_URL) process.env.AUDIT_URL = process.env.OPENPIM_AUDIT_URL

dotenv.config();
const app = express();
app.use(bodyParser.json({limit: '500mb'}));

(async () => {
  logger.info(`Server version: ${  version.buildMajor  }.${  version.buildMinor  }.${  version.buildRevision}`)
  logger.info(`Arguments: ${  process.argv}`)
  
  // Construct a schema, using GraphQL schema language
  const typeDefs = await importSchema('./schema/index.graphql'); 
  const schema = await makeExecutableSchema({ typeDefs, resolvers })

  await initModels();

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
      logger.info('Found key for company: ' + split[1]+' with data: '+channelTypes)
    } else {
      logger.error('Wrong key')
      channelTypes = []
    }
  }

  ModelsManager.getInstance().init(channelTypes)
  ChannelsManagerFactory.getInstance().init()
  
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
  
  app.use('/graphql', graphqlHTTP(async (request: IncomingMessage ) => ({
    schema,
    graphiql: false,
    context: await Context.create(request),
    customFormatErrorFn: (error: GraphQLError) => {
      const params = {
        message: error.message
      };
      logger.error('ERROR -', error, error.source);
      logger.error(`   request - ${ JSON.stringify((<any>request).body)}`);
      return (params);
    },
    extensions: ({ document, result }) => {
      if (logger.transports[0].level === 'debug') logger.debug('Request:\n'+print(document)+'Response:\n'+JSON.stringify(result)+'\n\n')
      return undefined
    }
  })));

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

      await processUpload(context, req, res)
    } catch (error: any) {
      res.status(400).send(error.message)
    }
  })

  await Context.init()
  app.listen(process.env.PORT);
  logger.info('Running a GraphQL API server at http://localhost:' + process.env.PORT + '/graphql');
})();