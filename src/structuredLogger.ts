import { Request, RequestHandler, Response } from 'express'
import { Client, ClientOptions } from '@elastic/elasticsearch'
import { getOperationAST, Kind, OperationDefinitionNode, parse } from 'graphql'
import * as fs from 'fs'
import * as path from 'path'
import logger from './logger'

export type StructuredRequestType = 'query' | 'mutation' | 'file' | 'system'
export type StructuredLogOutputType = 'console.out' | 'console.error' | 'file' | 'elasticsearch'

export type StructuredLogElasticsearchAuth =
    | { username: string; password: string }
    | { apiKey: string }

export type StructuredLogOutput =
    | { type?: 'console.out' }
    | { type: 'console.error' }
    | {
        type: 'file'
        path: string
        maxSize?: number
        maxFiles?: number
    }
    | {
        type: 'elasticsearch'
        node: string
        index?: string
        auth?: StructuredLogElasticsearchAuth
    }

export interface StructuredLogConfig {
    enabled?: boolean
    fromApp?: string
    maxMessageSize?: number
    output?: StructuredLogOutput
}

export interface StructuredLogInput {
    request_type: StructuredRequestType
    request_operation: string
    request_parameters: unknown
    login?: string | null
    execution_time: number
    request: unknown
    response: unknown
    status: number
    timestamp?: number
}

export interface StructuredLogRecord {
    '__from_app': string
    '@timestamp': number
    request_type: StructuredRequestType
    request_operation: string
    request_parameters: string
    login: string
    execution_time: number
    request: string
    response: string
    status: number
}

interface NormalizedConfig {
    enabled: boolean
    fromApp: string
    maxMessageSize: number
    outputType: StructuredLogOutputType
    filePath: string
    fileMaxSize: number
    fileMaxFiles: number
    elasticsearch: {
        node: string
        index: string
        username: string
        password: string
        apiKey: string
    } | null
}

export interface StructuredLogWriters {
    stdout: (value: string) => void
    stderr: (value: string) => void
}

interface RequestDescription {
    type: StructuredRequestType
    operation: string
    parameters: unknown
    request: unknown
}

const REDACTED = '[REDACTED]'
const TRUNCATED = '... [TRUNCATED]'
const MIN_MESSAGE_SIZE = 256
const DEFAULT_MESSAGE_SIZE = 10_000
const DEFAULT_FILE_SIZE = 10 * 1024 * 1024
const MAX_LOGGED_ROWS = 2
const FROM_APP_ENV_PATTERN = /^%([A-Za-z_][A-Za-z0-9_]*)%$/
const DEFAULT_ELASTICSEARCH_INDEX = 'pim-request-logs'
const DEFAULT_WRITERS: StructuredLogWriters = {
    stdout: value => { process.stdout.write(value) },
    stderr: value => { process.stderr.write(value) },
}

interface SanitizationOptions {
    maxRows?: number
}

const SENSITIVE_KEYS = new Set([
    'password',
    'passwd',
    'pwd',
    'token',
    'accesstoken',
    'refreshtoken',
    'authorization',
    'cookie',
    'setcookie',
    'secret',
    'clientsecret',
    'apikey',
    'key',
    'credentials',
    'credit',
])

const FILE_OPERATION_PATTERN = /(?:^|[-_/])(asset|attachment|bulk-upload|download|execution[-_]log|file|image|import-config-data|import-upload|media|process-upload|template|upload|webdav)(?:$|[-_/])/i

function positiveInteger(value: unknown, fallback: number, minimum = 1) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.max(minimum, Math.floor(value))
        : fallback
}

function getFromAppEnvironmentName(value: unknown): string | null {
    if (typeof value !== 'string') return null
    return FROM_APP_ENV_PATTERN.exec(value.trim())?.[1] || null
}

function resolveConfigValue(value: unknown, environment: NodeJS.ProcessEnv = process.env): string {
    if (typeof value !== 'string') return ''
    const configuredValue = value.trim()
    const environmentName = getFromAppEnvironmentName(configuredValue)
    if (!environmentName) return configuredValue
    return environment[environmentName]?.trim() || ''
}

export function resolveFromApp(value: unknown, environment: NodeJS.ProcessEnv = process.env): string {
    if (typeof value !== 'string' || !value.trim()) return 'PIM'
    const configuredValue = value.trim()
    const environmentName = getFromAppEnvironmentName(configuredValue)
    if (!environmentName) return configuredValue

    const environmentValue = environment[environmentName]
    return typeof environmentValue === 'string' && environmentValue.trim()
        ? environmentValue.trim()
        : 'unknown'
}

export function normalizeStructuredLogConfig(
    config: StructuredLogConfig | null | undefined,
    environment: NodeJS.ProcessEnv = process.env
): NormalizedConfig {
    const output = config?.output
    const outputType = output?.type
    const maxMessageSize = positiveInteger(config?.maxMessageSize, DEFAULT_MESSAGE_SIZE, MIN_MESSAGE_SIZE)
    const fileOutput = output?.type === 'file' ? output : null
    const elasticsearchOutput = output?.type === 'elasticsearch' ? output : null
    const configuredFileMaxSize = positiveInteger(fileOutput?.maxSize, DEFAULT_FILE_SIZE)
    const auth = elasticsearchOutput?.auth
    return {
        enabled: config?.enabled === true,
        fromApp: resolveFromApp(config?.fromApp, environment),
        maxMessageSize,
        outputType: outputType === 'console.error' || outputType === 'file' || outputType === 'elasticsearch' ? outputType : 'console.out',
        filePath: typeof fileOutput?.path === 'string' ? fileOutput.path : '',
        fileMaxSize: Math.max(configuredFileMaxSize, maxMessageSize + 1),
        fileMaxFiles: positiveInteger(fileOutput?.maxFiles, 1),
        elasticsearch: elasticsearchOutput ? {
            node: resolveConfigValue(elasticsearchOutput.node, environment),
            index: resolveConfigValue(elasticsearchOutput.index, environment) || DEFAULT_ELASTICSEARCH_INDEX,
            username: auth && 'username' in auth ? resolveConfigValue(auth.username, environment) : '',
            password: auth && 'password' in auth ? resolveConfigValue(auth.password, environment) : '',
            apiKey: auth && 'apiKey' in auth ? resolveConfigValue(auth.apiKey, environment) : '',
        } : null,
    }
}

function normalizeSensitiveKey(key: string) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveKey(key: string) {
    const normalized = normalizeSensitiveKey(key)
    if (SENSITIVE_KEYS.has(normalized)) return true

    const words = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
    return words.some(word => SENSITIVE_KEYS.has(word))
        || /(?:password|passwd|token|authorization|cookie|secret|credential|apikey)/.test(normalized)
}

function sanitizeString(value: string, options: SanitizationOptions = {}): string {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.stringify(sanitizeForLog(JSON.parse(value), new WeakSet<object>(), options))
        } catch (_) {
            // It is not JSON; apply the text rules below.
        }
    }

    const sensitiveNames = '(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|secret|client[_-]?secret|api[_-]?key|apikey|key|credentials|credit)'
    return value
        .replace(/(authorization\s*:\s*)(?:basic|bearer)\s+[^\s,;]+/gi, `$1${REDACTED}`)
        .replace(/((?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, `$1${REDACTED}`)
        .replace(new RegExp(`(["']?${sensitiveNames}["']?\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`, 'gi'), `$1"${REDACTED}"`)
        .replace(new RegExp(`(${sensitiveNames}\\s*[:=]\\s*)(?!["'])[^\\s,;&)]+`, 'gi'), `$1${REDACTED}`)
        .replace(/([?&](?:password|passwd|pwd|token|access_token|refresh_token|authorization|secret|client_secret|api_key|apikey|key|credentials|credit)=)[^&#\s]*/gi, `$1${REDACTED}`)
}

/** Creates a sanitized copy and never mutates the supplied value. */
export function sanitizeForLog(
    value: unknown,
    seen = new WeakSet<object>(),
    options: SanitizationOptions = {},
    limitRows = false
): unknown {
    if (value === null) return null
    if (value === undefined) return '[UNDEFINED]'
    if (typeof value === 'string') return sanitizeString(value, options)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'symbol') return value.toString()
    if (typeof value === 'function') return '[FUNCTION]'

    if (Buffer.isBuffer(value)) return `[BUFFER ${value.length} bytes]`
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Error) {
        return {
            name: value.name,
            message: sanitizeString(value.message, options),
            stack: value.stack ? sanitizeString(value.stack, options) : undefined,
        }
    }

    const object = value as object
    if (seen.has(object)) return '[CIRCULAR]'
    seen.add(object)

    try {
        if (Array.isArray(value)) {
            const items = limitRows && typeof options.maxRows === 'number'
                ? value.slice(0, options.maxRows)
                : value
            return items.map(item => sanitizeForLog(item, seen, options))
        }

        const result: Record<string, unknown> = {}
        for (const key of Object.keys(value as Record<string, unknown>)) {
            if (isSensitiveKey(key)) {
                result[key] = REDACTED
                continue
            }
            try {
                result[key] = sanitizeForLog(
                    (value as Record<string, unknown>)[key],
                    seen,
                    options,
                    key.toLowerCase() === 'rows'
                )
            } catch (_) {
                result[key] = '[UNAVAILABLE]'
            }
        }
        return result
    } finally {
        seen.delete(object)
    }
}

function safelySerialize(value: unknown, options: SanitizationOptions = {}): string {
    try {
        const sanitized = sanitizeForLog(value, new WeakSet<object>(), options)
        return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized)
    } catch (_) {
        return '[UNSERIALIZABLE]'
    }
}

function containsRowsArray(value: unknown, seen = new WeakSet<object>()): boolean {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) return false
        try {
            return containsRowsArray(JSON.parse(value), seen)
        } catch (_) {
            return false
        }
    }
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date || value instanceof Error) return false
    if (seen.has(value)) return false
    seen.add(value)

    try {
        if (Array.isArray(value)) return value.some(item => containsRowsArray(item, seen))
        for (const key of Object.keys(value as Record<string, unknown>)) {
            let child: unknown
            try {
                child = (value as Record<string, unknown>)[key]
            } catch (_) {
                continue
            }
            if (key.toLowerCase() === 'rows' && Array.isArray(child)) return true
            if (containsRowsArray(child, seen)) return true
        }
        return false
    } finally {
        seen.delete(value)
    }
}

function byteLength(value: string) {
    return Buffer.byteLength(value, 'utf8')
}

export function truncateUtf8(value: string, maxBytes: number): string {
    if (byteLength(value) <= maxBytes) return value
    if (maxBytes <= byteLength(TRUNCATED)) return TRUNCATED.slice(0, Math.max(0, maxBytes))

    const contentBytes = maxBytes - byteLength(TRUNCATED)
    let truncated = Buffer.from(value, 'utf8').subarray(0, contentBytes).toString('utf8')
    if (truncated.endsWith('\uFFFD')) truncated = truncated.slice(0, -1)
    return truncated + TRUNCATED
}

function serializeRecord(record: StructuredLogRecord) {
    return JSON.stringify(record)
}

function fitRecordToLimit(record: StructuredLogRecord, limit: number, preserveStructuredResponse = false): string {
    let serialized = serializeRecord(record)
    type ShrinkableKey = keyof Pick<StructuredLogRecord, 'response' | 'request' | 'request_parameters' | 'request_operation' | 'login' | '__from_app'>
    const shrinkable: ShrinkableKey[] = preserveStructuredResponse
        ? ['request', 'request_parameters', 'request_operation', 'login', '__from_app']
        : ['response', 'request', 'request_parameters', 'request_operation', 'login', '__from_app']

    for (const key of shrinkable) {
        if (byteLength(serialized) <= limit) break
        const current = record[key]
        const overflow = byteLength(serialized) - limit
        const target = Math.max(byteLength(TRUNCATED), byteLength(current) - overflow - 8)
        record[key] = truncateUtf8(current, target)
        serialized = serializeRecord(record)
    }

    // The configured minimum leaves room for all required keys. This is a final
    // defensive pass for unusually large numeric values or escape expansion.
    while (!preserveStructuredResponse && byteLength(serialized) > limit && record.response.length > byteLength(TRUNCATED)) {
        record.response = truncateUtf8(record.response, Math.max(byteLength(TRUNCATED), byteLength(record.response) - 16))
        serialized = serializeRecord(record)
    }

    for (const key of shrinkable) {
        if (byteLength(serialized) <= limit) break
        record[key] = ''
        serialized = serializeRecord(record)
    }
    return serialized
}

export function formatStructuredLog(config: StructuredLogConfig | null | undefined, input: StructuredLogInput): string | null {
    const normalized = normalizeStructuredLogConfig(config)
    if (!normalized.enabled) return null

    const fieldLimit = normalized.maxMessageSize
    const preserveStructuredResponse = containsRowsArray(input.response)
    const serializedResponse = safelySerialize(input.response, { maxRows: MAX_LOGGED_ROWS })
    const record: StructuredLogRecord = {
        '__from_app': normalized.fromApp,
        '@timestamp': input.timestamp ?? Date.now(),
        request_type: input.request_type,
        request_operation: truncateUtf8(safelySerialize(input.request_operation), fieldLimit),
        request_parameters: truncateUtf8(safelySerialize(input.request_parameters), fieldLimit),
        login: truncateUtf8(safelySerialize(input.login || 'unknown'), fieldLimit),
        execution_time: Math.max(0, Math.round(input.execution_time)),
        request: truncateUtf8(safelySerialize(input.request), fieldLimit),
        response: preserveStructuredResponse ? serializedResponse : truncateUtf8(serializedResponse, fieldLimit),
        status: input.status,
    }

    return fitRecordToLimit(record, normalized.maxMessageSize, preserveStructuredResponse)
}

class StructuredLogTransport {
    private queue: Promise<void> = Promise.resolve()
    private elasticsearchClient: Client | null = null
    private elasticsearchIndexReady: Promise<void> | null = null

    public constructor(
        private readonly config: NormalizedConfig,
        private readonly writers: StructuredLogWriters
    ) {}

    public write(line: string) {
        if (this.config.outputType === 'console.out') {
            try {
                this.writers.stdout(line + '\n')
            } catch (error) {
                this.reportError(error)
            }
            return
        }
        if (this.config.outputType === 'console.error') {
            try {
                this.writers.stderr(line + '\n')
            } catch (error) {
                this.reportError(error)
            }
            return
        }

        this.queue = this.queue
            .then(() => this.config.outputType === 'elasticsearch'
                ? this.appendToElasticsearch(line)
                : this.appendToFile(line))
            .catch(error => this.reportError(error))
    }

    public async flush() {
        await this.queue
    }

    private async appendToFile(line: string) {
        if (!this.config.filePath) throw new Error('Structured log output file path is empty')

        await fs.promises.mkdir(path.dirname(this.config.filePath), { recursive: true })
        const data = line + '\n'
        let currentSize = 0
        try {
            currentSize = (await fs.promises.stat(this.config.filePath)).size
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error
        }

        if (currentSize > 0 && currentSize + byteLength(data) > this.config.fileMaxSize) {
            await this.rotateFiles()
        }
        await fs.promises.appendFile(this.config.filePath, data, 'utf8')
    }

    private getElasticsearchClient() {
        if (this.elasticsearchClient) return this.elasticsearchClient
        const elasticsearch = this.config.elasticsearch
        if (!elasticsearch?.node) throw new Error('Structured log Elasticsearch node is empty')

        const clientOptions: ClientOptions = { node: elasticsearch.node }
        if (elasticsearch.apiKey) {
            clientOptions.auth = { apiKey: elasticsearch.apiKey }
        } else if (elasticsearch.username || elasticsearch.password) {
            if (!elasticsearch.username || !elasticsearch.password) {
                throw new Error('Structured log Elasticsearch basic authentication requires both username and password')
            }
            clientOptions.auth = { username: elasticsearch.username, password: elasticsearch.password }
        }

        this.elasticsearchClient = new Client(clientOptions)
        return this.elasticsearchClient
    }

    private async ensureElasticsearchIndex() {
        if (this.elasticsearchIndexReady) return this.elasticsearchIndexReady
        const elasticsearch = this.config.elasticsearch
        if (!elasticsearch) throw new Error('Structured log Elasticsearch configuration is missing')
        const client = this.getElasticsearchClient()

        const updateExistingMapping = async () => {
            await client.indices.putMapping({
                index: elasticsearch.index,
                properties: {
                    '__from_app': { type: 'keyword' },
                    '@timestamp': { type: 'date', format: 'epoch_millis' },
                    request_type: { type: 'keyword' },
                    request_operation: { type: 'keyword' },
                    login: { type: 'keyword' },
                    execution_time: { type: 'long' },
                    status: { type: 'integer' },
                    request_parameters: { type: 'text', index: false },
                    request: { type: 'text', index: false },
                    response: { type: 'text', index: false },
                },
            })
        }

        this.elasticsearchIndexReady = client.indices.create({
            index: elasticsearch.index,
            mappings: {
                properties: {
                    '__from_app': { type: 'keyword' },
                    '@timestamp': { type: 'date', format: 'epoch_millis' },
                    request_type: { type: 'keyword' },
                    request_operation: { type: 'keyword' },
                    login: { type: 'keyword' },
                    execution_time: { type: 'long' },
                    status: { type: 'integer' },
                    request_parameters: { type: 'text', index: false },
                    request: { type: 'text', index: false },
                    response: { type: 'text', index: false },
                },
            },
        }).then(() => undefined).catch((error: any) => {
            const statusCode = error?.meta?.statusCode
            const errorType = error?.meta?.body?.error?.type
            if (statusCode === 400 && errorType === 'resource_already_exists_exception') {
                return updateExistingMapping()
            }
            // A deployment may allow document writes while managing mappings
            // centrally and denying index administration to the application.
            if (statusCode === 401 || statusCode === 403) return
            this.elasticsearchIndexReady = null
            throw error
        })
        return this.elasticsearchIndexReady
    }

    private async appendToElasticsearch(line: string) {
        const elasticsearch = this.config.elasticsearch
        if (!elasticsearch) throw new Error('Structured log Elasticsearch configuration is missing')
        await this.ensureElasticsearchIndex()
        const document = JSON.parse(line) as StructuredLogRecord
        await this.getElasticsearchClient().index({
            index: elasticsearch.index,
            document,
        })
    }

    private async rotateFiles() {
        const removeIfExists = async (filePath: string) => {
            try {
                await fs.promises.unlink(filePath)
            } catch (error: any) {
                if (error?.code !== 'ENOENT') throw error
            }
        }

        await removeIfExists(`${this.config.filePath}.${this.config.fileMaxFiles}`)
        for (let index = this.config.fileMaxFiles - 1; index >= 1; index--) {
            try {
                await fs.promises.rename(`${this.config.filePath}.${index}`, `${this.config.filePath}.${index + 1}`)
            } catch (error: any) {
                if (error?.code !== 'ENOENT') throw error
            }
        }
        try {
            await fs.promises.rename(this.config.filePath, `${this.config.filePath}.1`)
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error
        }
    }

    private reportError(error: unknown) {
        try {
            logger.error('Structured request logger failed', error)
        } catch (_) {
            // Logging must never affect the request being served.
        }
    }
}

function getGraphQLDescription(request: Request): RequestDescription {
    const body = request.body || {}
    const query = typeof body.query === 'string' ? body.query : ''
    let operation: OperationDefinitionNode | null = null
    try {
        operation = getOperationAST(parse(query), typeof body.operationName === 'string' ? body.operationName : undefined) || null
    } catch (_) {
        // Invalid GraphQL requests are still logged and handled by graphql-http.
    }

    const firstField = operation?.selectionSet.selections.find(selection => selection.kind === Kind.FIELD)
    const operationName = operation?.name?.value || (firstField?.kind === Kind.FIELD ? firstField.name.value : undefined)
    const type: StructuredRequestType = operation?.operation === 'mutation' ? 'mutation' : 'query'
    return {
        type,
        operation: operationName || (typeof body.operationName === 'string' ? body.operationName : 'anonymous'),
        parameters: body.variables || {},
        request: query || body,
    }
}

function normalizeRouteOperation(request: Request) {
    const routePath = typeof request.route?.path === 'string'
        ? request.route.path
        : request.path
    const operation = routePath
        .replace(/:[^/]+/g, '')
        .split('/')
        .filter(Boolean)
        .join('-')
    return operation || request.method.toLowerCase()
}

export function describeHttpRequest(request: Request): RequestDescription {
    if (request.path === '/graphql' || request.originalUrl.split('?')[0] === '/graphql') {
        return getGraphQLDescription(request)
    }

    const operation = normalizeRouteOperation(request)
    const type: StructuredRequestType = FILE_OPERATION_PATTERN.test(operation) || operation === 'mi' || operation === 'templateforitems'
        ? 'file'
        : 'system'
    return {
        type,
        operation,
        parameters: {
            params: request.params || {},
            query: request.query || {},
            body: request.body || {},
        },
        request: {
            method: request.method,
            url: request.originalUrl,
            headers: request.headers,
            body: request.body,
        },
    }
}

function responseValue(chunks: Buffer[], totalBytes: number, response: Response) {
    const contentType = String(response.getHeader('content-type') || '')
    const isText = !contentType || /(?:json|text|xml|graphql|javascript|x-www-form-urlencoded)/i.test(contentType)
    if (!isText) return `[BINARY RESPONSE: ${contentType || 'unknown'}, ${totalBytes} bytes]`
    return Buffer.concat(chunks).toString('utf8')
}

function findLogin(request: Request) {
    const attachedLogin = (request as any).structuredLogLogin
    if (typeof attachedLogin === 'string' && attachedLogin) return attachedLogin
    const bodyLogin = request.body?.variables?.login ?? request.body?.login
    return typeof bodyLogin === 'string' && bodyLogin ? bodyLogin : 'unknown'
}

export class StructuredRequestLogger {
    private readonly normalized: NormalizedConfig
    private readonly transport: StructuredLogTransport

    public constructor(
        private readonly config: StructuredLogConfig | null | undefined,
        writers: StructuredLogWriters = DEFAULT_WRITERS
    ) {
        this.normalized = normalizeStructuredLogConfig(config)
        this.transport = new StructuredLogTransport(this.normalized, writers)
        const fromAppEnvironmentName = getFromAppEnvironmentName(config?.fromApp)
        const fromAppEnvironmentValue = fromAppEnvironmentName ? process.env[fromAppEnvironmentName] : undefined
        const isFromAppEnvironmentMissing = typeof fromAppEnvironmentValue !== 'string' || !fromAppEnvironmentValue.trim()
        if (this.normalized.enabled && fromAppEnvironmentName && isFromAppEnvironmentMissing) {
            try {
                logger.warn(`Structured request logger environment variable ${fromAppEnvironmentName} is not set; fromApp will be unknown`)
            } catch (_) {
                // Configuration diagnostics must not prevent application startup.
            }
        }
    }

    public isEnabled() {
        return this.normalized.enabled
    }

    public log(input: StructuredLogInput) {
        if (!this.normalized.enabled) return
        try {
            const line = formatStructuredLog(this.config, input)
            if (line) this.transport.write(line)
        } catch (error) {
            try {
                logger.error('Failed to format structured request log', error)
            } catch (_) {
                // Best effort only.
            }
        }
    }

    public middleware(): RequestHandler {
        if (!this.normalized.enabled) return (_request, _response, next) => next()

        return (request, response, next) => {
            const started = process.hrtime.bigint()
            const captureLimit = this.normalized.maxMessageSize
            const chunks: Buffer[] = []
            let capturedBytes = 0
            let totalBytes = 0
            let logged = false
            const originalWrite = response.write
            const originalEnd = response.end
            const originalJson = response.json

            const capture = (chunk: any, encoding?: BufferEncoding) => {
                if (chunk === undefined || chunk === null || typeof chunk === 'function') return
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding)
                totalBytes += buffer.length
                if (capturedBytes < captureLimit) {
                    const part = buffer.subarray(0, captureLimit - capturedBytes)
                    chunks.push(part)
                    capturedBytes += part.length
                }
            }

            ;(response.write as any) = (...args: any[]) => {
                try {
                    capture(args[0], typeof args[1] === 'string' ? args[1] as BufferEncoding : undefined)
                } catch (_) {
                    // Capturing is best-effort; preserve the original response path.
                }
                return originalWrite.apply(response, args as any)
            }
            ;(response.end as any) = (...args: any[]) => {
                try {
                    capture(args[0], typeof args[1] === 'string' ? args[1] as BufferEncoding : undefined)
                } catch (_) {
                    // Capturing is best-effort; preserve the original response path.
                }
                return originalEnd.apply(response, args as any)
            }
            ;(response.json as any) = (body: unknown) => {
                ;(request as any).structuredLogResponse = body
                return originalJson.call(response, body)
            }

            const finish = () => {
                if (logged) return
                logged = true
                try {
                    const description = describeHttpRequest(request)
                    const hasStructuredResponse = Object.prototype.hasOwnProperty.call(request, 'structuredLogResponse')
                    this.log({
                        request_type: description.type,
                        request_operation: description.operation,
                        request_parameters: description.parameters,
                        login: findLogin(request),
                        execution_time: Number(process.hrtime.bigint() - started) / 1_000_000,
                        request: description.request,
                        response: hasStructuredResponse
                            ? (request as any).structuredLogResponse
                            : responseValue(chunks, totalBytes, response),
                        status: response.statusCode || 500,
                    })
                } catch (error) {
                    try {
                        logger.error('Failed to capture structured request log', error)
                    } catch (_) {
                        // Best effort only.
                    }
                }
            }

            response.once('finish', finish)
            response.once('close', finish)
            next()
        }
    }

    public async flush() {
        await this.transport.flush()
    }
}
