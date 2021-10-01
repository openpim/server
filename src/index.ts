import * as express from 'express'
import { graphqlHTTP } from 'express-graphql' 
import { importSchema } from 'graphql-import'
import { makeExecutableSchema } from 'graphql-tools'
import { GraphQLError } from 'graphql'
import * as cors from 'cors'
import * as bodyParser from 'body-parser'
import logger from './logger'

import * as dotenv from "dotenv";

import * as crypto from "crypto"
import { Buffer } from 'buffer'

const env = process.argv.length > 2 ? '.'+process.argv[2] : ''
logger.info("Using environment: [" + env + "]")
dotenv.config({ path: './.env' + env  })

if (process.env.OPENPIM_DATABASE_ADDRESS) process.env.DATABASE_URL = process.env.OPENPIM_DATABASE_ADDRESS
if (process.env.OPENPIM_DATABASE_NAME) process.env.DATABASE_NAME = process.env.OPENPIM_DATABASE_NAME
if (process.env.OPENPIM_DATABASE_PORT) process.env.DATABASE_PORT = process.env.OPENPIM_DATABASE_PORT
if (process.env.OPENPIM_DATABASE_USER) process.env.DATABASE_USER = process.env.OPENPIM_DATABASE_USER
if (process.env.OPENPIM_DATABASE_PASSWORD) process.env.DATABASE_PASSWORD = process.env.OPENPIM_DATABASE_PASSWORD
if (process.env.OPENPIM_AUDIT_URL) process.env.AUDIT_URL = process.env.OPENPIM_AUDIT_URL

import resolvers from './resolvers'
import Context from './context'
import { IncomingMessage } from 'http';
import { initModels } from './models'
import { ModelsManager } from './models/manager'
import { processUpload, processCreateUpload, processDownload, processChannelDownload } from './media';

import version from './version'
import { ChannelsManagerFactory } from './channels'

// Construct a schema, using GraphQL schema language
async function start() { 
  logger.info('Server version: ' + version.buildMajor + '.' + version.buildMinor + "." + version.buildRevision)
  logger.info('Arguments: ' + process.argv)
  
  const typeDefs = await importSchema('./schema/index.graphql'); 
  let schema = await makeExecutableSchema({ typeDefs, resolvers })

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

  let app = express();
  app.use(bodyParser.json({limit: '100mb'}));
  app.use(cors())
  
  app.use('/graphql', graphqlHTTP(async (request: IncomingMessage ) => ({
    schema: schema,
    graphiql: false,
    context: await Context.create(request),
    customFormatErrorFn: (error: GraphQLError) => {
      const params = {
        message: error.message
      };
      // console.log(request)
      logger.error('ERROR -', error, error.source);
      logger.error('   request - ' + JSON.stringify((<any>request).body));
      return (params);
    }
  })));

  app.post('/asset-upload', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()

      await processUpload(context, req, res)
    } catch (error) {
      res.status(400).send(error.message)
    }
  })

  app.post('/asset-create-upload', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()

      await processCreateUpload(context, req, res)
    } catch (error) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      await processDownload(context, req, res, false)
    } catch (error) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset/:id/thumb', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await processDownload(context, req, res, true)
    } catch (error) {
      res.status(400).send(error.message)
    }
  })

  app.get('/asset-channel/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
      await processChannelDownload(context, req, res, false)
    } catch (error) {
      res.status(400).send(error.message)
    }
  })

  app.listen(process.env.PORT);
  logger.info('Running a GraphQL API server at http://localhost:'+process.env.PORT+'/graphql');
}

start()