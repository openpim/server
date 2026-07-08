import { GraphQLError } from 'graphql'

export const AUTH_ERROR_MESSAGES = new Set([
    'Wrong login or password',
    'User is not authenticated',
    'Your session expired. Sign in again.',
])

export function createUnauthorizedError(message: string) {
    return new GraphQLError(message, {
        extensions: {
            code: 'UNAUTHENTICATED',
            http: {
                status: 401,
            },
        },
    })
}

export function getGraphQLErrorStatus(error: unknown): number | undefined {
    if (!(error instanceof GraphQLError)) return undefined

    const httpStatus = error.extensions?.http
    if (httpStatus && typeof httpStatus === 'object' && 'status' in httpStatus) {
        const status = (httpStatus as { status?: unknown }).status
        if (typeof status === 'number') return status
    }

    if (error.extensions?.code === 'UNAUTHENTICATED') return 401
    if (AUTH_ERROR_MESSAGES.has(error.message)) return 401
    return undefined
}

export function isUnauthorizedGraphQLError(error: unknown) {
    return getGraphQLErrorStatus(error) === 401
}
