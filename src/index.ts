import * as express from 'express';
import * as graphqlHTTP from 'express-graphql'; 
import { importSchema } from 'graphql-import'
import { makeExecutableSchema } from 'graphql-tools'
import { GraphQLError } from 'graphql'
import * as cors from 'cors'
// import * as bodyParser from 'body-parser'

import * as dotenv from "dotenv";
const env = process.argv.length > 2 ? '.'+process.argv[2] : ''
console.log("Using environment: [" + env + "]")
dotenv.config({ path: './.env' + env  })

import resolvers from './resolvers'
import Context from './context'
import { IncomingMessage } from 'http';
import { initModels } from './models'
import { ModelsManager } from './models/manager'
import { processUpload, processDownload } from './media';

// Construct a schema, using GraphQL schema language
async function start() {
  console.log('Arguments: ' + process.argv)
  
  const typeDefs = await importSchema('./schema/index.graphql'); 
  let schema = await makeExecutableSchema({ typeDefs, resolvers })

  await initModels();
  ModelsManager.getInstance().init()

  let app = express();
  app.use(cors())
  // app.use(bodyParser.json({ limit: '1mb' })); - this is not working, how to increase buffer? Now it is 100K
  app.use('/graphql', graphqlHTTP(async (request: IncomingMessage ) => ({
    schema: schema,
    graphiql: false,
    context: await Context.create(request),
    customFormatErrorFn: (error: GraphQLError) => {
      const params = {
        message: error.message
      };
      console.error('ERROR -', error, error.source);
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
  console.log('Running a GraphQL API server at http://localhost:'+process.env.PORT+'/graphql');
}

start()