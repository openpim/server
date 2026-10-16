import fetch from 'node-fetch'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { normalizeVector } from './retrieval'

export interface LocalEmbeddingConfig { baseUrl: string; model: string; timeoutMs: number; batchSize: number }
export interface EmbeddingCache { version: 1; entries: [string, number[]][] }
const canonicalModel = (model: string) => model.includes(':') ? model : model + ':latest'

export function readLocalEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): LocalEmbeddingConfig {
    const baseUrl = (env.OPENPIM_AI_EMBEDDING_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
    let url: URL
    try { url = new URL(baseUrl) } catch { throw new Error('Invalid local embedding URL.') }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Embedding URL must be a plain HTTP loopback origin.')
    const model = canonicalModel(env.OPENPIM_AI_EMBEDDING_MODEL || 'bge-m3:latest')
    if (!/^[a-zA-Z0-9_./:-]{1,150}$/.test(model) || /cloud/i.test(model)) throw new Error('A local embedding model is required; cloud models are forbidden.')
    const integer = (name: string, fallback: number, max: number) => {
        const value = env[name] === undefined ? fallback : Number(env[name])
        if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid ' + name)
        return value
    }
    return { baseUrl, model, timeoutMs: integer('OPENPIM_AI_EMBEDDING_TIMEOUT_MS', 60000, 300000), batchSize: integer('OPENPIM_AI_EMBEDDING_BATCH_SIZE', 16, 32) }
}

export class LocalEmbeddingClient {
    private readonly config: LocalEmbeddingConfig
    private readonly cache = new Map<string, number[]>()
    private readonly cacheSizes = new Map<string, number>()
    private cacheBytes = 0
    private modelDigest: string | null = null
    private dimensions: number | undefined
    readonly stats = { hits: 0, misses: 0, requests: 0, promptTokens: 0, embeddingMs: 0 }

    constructor(config: LocalEmbeddingConfig, cache?: EmbeddingCache) {
        // Apply the locality checks even when callers construct a configuration directly.
        this.config = readLocalEmbeddingConfig({ OPENPIM_AI_EMBEDDING_BASE_URL: config.baseUrl, OPENPIM_AI_EMBEDDING_MODEL: config.model, OPENPIM_AI_EMBEDDING_TIMEOUT_MS: String(config.timeoutMs), OPENPIM_AI_EMBEDDING_BATCH_SIZE: String(config.batchSize) })
        if (cache) {
            if (cache.version !== 1 || !Array.isArray(cache.entries) || cache.entries.length > 20000) throw new Error('Invalid embedding cache.')
            for (const [key, vector] of cache.entries) {
                if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid embedding cache key.')
                normalizeVector(vector)
                this.storeVector(key, vector)
            }
        }
    }

    private storeVector(key: string, vector: number[]): void {
        const bytes = Buffer.byteLength(JSON.stringify([key, vector]), 'utf8') + 1
        this.cacheBytes -= this.cacheSizes.get(key) || 0
        this.cache.delete(key)
        this.cache.set(key, vector.slice())
        this.cacheSizes.set(key, bytes)
        this.cacheBytes += bytes
        // Compact cache stays below the runner's 32 MiB read limit, including wrapper.
        while (this.cacheBytes > 30 * 1024 * 1024 || this.cache.size > 20000) {
            const oldest = this.cache.keys().next().value!
            this.cacheBytes -= this.cacheSizes.get(oldest)!
            this.cache.delete(oldest)
            this.cacheSizes.delete(oldest)
        }
    }

    private async json(path: string, body?: any, deadline?: number): Promise<any> {
        const timeoutMs = Math.min(this.config.timeoutMs, deadline === undefined ? this.config.timeoutMs : deadline - Date.now())
        if (timeoutMs <= 0) throw new Error('Local embedding API timeout.')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const response = await fetch(this.config.baseUrl + path, {
                method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
                timeout: timeoutMs, size: 8 * 1024 * 1024,
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                body: body ? JSON.stringify(body) : undefined
            })
            if (!response.ok) { (response.body as Readable | null)?.destroy(); throw new Error('Local embedding API HTTP ' + response.status) }
            return await response.json()
        } catch (error: any) {
            if (controller.signal.aborted || error.type === 'request-timeout' || error.type === 'body-timeout') throw new Error('Local embedding API timeout.')
            if (/^Local embedding API HTTP/.test(error.message)) throw error
            throw new Error('Local embedding API connection or JSON response failed.')
        } finally { clearTimeout(timer) }
    }

    async describeModel(deadline?: number): Promise<{ model: string; digest: string }> {
        if (!this.modelDigest) {
            const tags = await this.json('/api/tags', undefined, deadline)
            const tag = tags.models?.find((row: any) => canonicalModel(String(row.name)) === this.config.model)
            if (!tag || !/^[a-f0-9]{64}$/.test(tag.digest)) throw new Error('Installed local embedding model not found. No model is downloaded automatically.')
            const model = await this.json('/api/show', { model: this.config.model }, deadline)
            if (model.remote_host || model.remote_model || !Array.isArray(model.capabilities) || !model.capabilities.includes('embedding')) throw new Error('Model must support embeddings locally; remote models are forbidden.')
            this.modelDigest = tag.digest
        }
        return { model: this.config.model, digest: this.modelDigest! }
    }

    async embed(texts: string[], scope: string, language: string, deadline?: number): Promise<number[][]> {
        if (!scope || scope.length > 200 || !language || language.length > 50 || !Array.isArray(texts) || texts.length > 10000 || texts.some(text => typeof text !== 'string' || !text.trim() || text.length > 6000)) throw new Error('Invalid embedding scope, language or input (1–6000 characters per text).')
        if (!texts.length) return []
        const provenance = await this.describeModel(deadline)
        const keys = texts.map(text => createHash('sha256').update(JSON.stringify([1, this.config.baseUrl, provenance.model, provenance.digest, scope, language, text])).digest('hex'))
        const pending = new Map<string, string>()
        const results = new Map<string, number[]>()
        keys.forEach((key, index) => {
            if (this.cache.has(key)) {
                this.stats.hits++
                const vector = this.cache.get(key)!
                results.set(key, vector)
                this.cache.delete(key)
                this.cache.set(key, vector)
            }
            else if (!pending.has(key)) { pending.set(key, texts[index]); this.stats.misses++ }
        })
        const entries = [...pending.entries()]
        for (let index = 0; index < entries.length; index += this.config.batchSize) {
            const batch = entries.slice(index, index + this.config.batchSize)
            const started = Date.now()
            const result = await this.json('/api/embed', { model: this.config.model, input: batch.map(row => row[1]), truncate: false, keep_alive: '2m' }, deadline)
            this.stats.embeddingMs += Date.now() - started
            this.stats.requests++
            if (canonicalModel(String(result.model)) !== this.config.model || !Array.isArray(result.embeddings) || result.embeddings.length !== batch.length) throw new Error('Invalid local embedding vector response count/model.')
            const dimensions = this.dimensions || result.embeddings[0]?.length
            result.embeddings.forEach((vector: unknown) => normalizeVector(vector, dimensions))
            if (texts.length * dimensions > 4 * 1024 * 1024) throw new Error('Embedding result memory limit exceeded.')
            this.dimensions = dimensions
            if (Number.isSafeInteger(result.prompt_eval_count) && result.prompt_eval_count >= 0) this.stats.promptTokens += result.prompt_eval_count
            batch.forEach(([key], position) => {
                results.set(key, result.embeddings[position])
                this.storeVector(key, result.embeddings[position])
            })
        }
        const vectors = keys.map(key => results.get(key)!)
        const dimensions = this.dimensions || vectors[0]?.length
        if (texts.length * dimensions! > 4 * 1024 * 1024) throw new Error('Embedding result memory limit exceeded.')
        vectors.forEach(vector => normalizeVector(vector, dimensions))
        this.dimensions = dimensions
        return vectors.map(vector => vector.slice())
    }

    exportCache(): EmbeddingCache { return { version: 1, entries: [...this.cache].map(([key, vector]) => [key, vector.slice()]) } }
}
