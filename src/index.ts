import * as express from 'express'
import * as graphqlHTTP from 'express-graphql' 
import { importSchema } from 'graphql-import'
import { makeExecutableSchema } from 'graphql-tools'
import { GraphQLError } from 'graphql'
import * as cors from 'cors'
import * as bodyParser from 'body-parser'
import logger from './logger'

import * as dotenv from "dotenv";


const env = process.argv.length > 2 ? '.'+process.argv[2] : ''
logger.info("Using environment: [" + env + "]")
dotenv.config({ path: './.env' + env  })

if (process.env.OPENPIM_DATABASE_ADDRESS) process.env.DATABASE_URL = process.env.OPENPIM_DATABASE_ADDRESS
if (process.env.OPENPIM_DATABASE_NAME) process.env.DATABASE_NAME = process.env.OPENPIM_DATABASE_NAME
if (process.env.OPENPIM_DATABASE_USER) process.env.DATABASE_USER = process.env.OPENPIM_DATABASE_USER
if (process.env.OPENPIM_DATABASE_PASSWORD) process.env.DATABASE_PASSWORD = process.env.OPENPIM_DATABASE_PASSWORD

import resolvers from './resolvers'
import Context from './context'
import { IncomingMessage } from 'http';
import { initModels } from './models'
import { ModelsManager } from './models/manager'
import { processUpload, processDownload } from './media';

// Construct a schema, using GraphQL schema language
async function start() { 
  logger.info('Arguments: ' + process.argv)
  
  const typeDefs = await importSchema('./schema/index.graphql'); 
  let schema = await makeExecutableSchema({ typeDefs, resolvers })

  await initModels();
  ModelsManager.getInstance().init()

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

  app.get('/asset/:id', async (req, res) => {
    try {
      const context = await Context.create(req)
      context.checkAuth()
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

  app.listen(process.env.PORT);
  logger.info('Running a GraphQL API server at http://localhost:'+process.env.PORT+'/graphql');
}

start()