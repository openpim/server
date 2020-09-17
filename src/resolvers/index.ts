import userResolvers from './users'
import typeResolvers from './types'
import attrResolvers from './attributes'
import relResolvers from './relations'
import itemResolvers from './items'
import langResolvers from './languages'
import actionResolvers from './actions'
import dashResolvers from './dashboards'
import searchResolvers from './search'
import itemrelationsResolvers from './itemRelations'
import importResolvers from './import'
import lovResolvers from './lovs'
import GraphQLJSON, { GraphQLJSONObject } from 'graphql-type-json'
import LanguageDependentString from './utils/languageDependentString'
import { GraphQLDateTime } from 'graphql-iso-date'

const testResolver = {
    Query: {
        ping: () => {
            return 'pong'
        }
    }
}

export default {
    JSON: GraphQLJSON,
    JSONObject: GraphQLJSONObject,
    LanguageDependentString: LanguageDependentString,
    UTCDateTime: GraphQLDateTime,
    Query: {
        ...testResolver.Query,
        ...userResolvers.Query,
        ...typeResolvers.Query,
        ...attrResolvers.Query,
        ...relResolvers.Query,
        ...itemResolvers.Query,
        ...langResolvers.Query,
        ...actionResolvers.Query,
        ...dashResolvers.Query,
        ...itemrelationsResolvers.Query,
        ...searchResolvers.Query,
        ...lovResolvers.Query
    },
    Mutation: {
        ...userResolvers.Mutation,
        ...typeResolvers.Mutation,
        ...attrResolvers.Mutation,
        ...relResolvers.Mutation,
        ...itemResolvers.Mutation,
        ...langResolvers.Mutation,
        ...actionResolvers.Mutation,
        ...dashResolvers.Mutation,
        ...itemrelationsResolvers.Mutation,
        ...importResolvers.Mutation,
        ...searchResolvers.Mutation,
        ...lovResolvers.Mutation
    },
    SearchResponse: {
        ...searchResolvers.SearchResponse
    }
}