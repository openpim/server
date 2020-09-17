import { GraphQLScalarType, Kind, StringValueNode } from 'graphql'

// https://stackoverflow.com/questions/41510880/whats-the-difference-between-parsevalue-and-parseliteral-in-graphqlscalartype
export default new GraphQLScalarType({
    name: 'LanguageDependentString',
    description: 'String that can has several values depending of language: {"en":"english text", "ru":"russian text", etc}',
    serialize: (value) => {
        return value
    },
    parseValue: (value) => {
        return value
    },
    parseLiteral: (ast) => {
        if (ast.kind === Kind.STRING) {
            return JSON.parse(ast.value)
        } else if (ast.kind === Kind.OBJECT) {
            const res:any = {}
            ast.fields.forEach(field => {
                res[field.name.value] = (<StringValueNode>field.value).value
            })
            return res
        } else {}
            return null
        }
})
  