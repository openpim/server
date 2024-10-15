import Context from './context';
import logger from './logger';
import Prometheus from 'prom-client';
import promBundle from 'express-prom-bundle';
import userResolver from './resolvers/users';

let allTime: any = 0
let counter: number = 0
let counter05: number = 0
let counter1: number = 0
let counter3: number = 0
let counter5: number = 0
let counter10: number = 0
let counterInf: number = 0
let metricAverageTime: number = 0
const bigQueries: any = Array(process.env.OPENPIM_DATABASE_METRICS_COUNT ? parseInt(process.env.OPENPIM_DATABASE_METRICS_COUNT) : 10).fill(null)
const metrics: any = {}

export function getMetrics(sql: string, timingMs: any) {
    const date = new Date()
    for (let i = 0; i < bigQueries.length; i++) {
        const query = bigQueries[i]
        if (query === null && timingMs) {
            bigQueries[i] = {sql, timingMs, startTime: date}
            console.log(bigQueries[i])
        } else if (query && timingMs && query.timingMs < timingMs) {
            for (let j = bigQueries.length - 1; j > i; j--) {
                bigQueries[j] = bigQueries[j - 1]
            }
            bigQueries[i] = {sql, timingMs, startTime: date}
            console.log(bigQueries[i])
            break
        }
    }

    allTime += timingMs
    metricAverageTime = allTime / counter
    counter++

    if (timingMs) {
        if (timingMs <= 500) {
            counter05++
        } else if (timingMs > 500 && timingMs <= 1000) {
            counter1++
        } else if (timingMs > 1000 && timingMs <= 3000) {
            counter3++
        } else if (timingMs > 3000 && timingMs <= 5000) {
            counter5++
        } else if (timingMs > 5000 && timingMs <= 10000) {
            counter10++
        } else if (timingMs > 10000) {
            counterInf++
        }
    }

    metrics.bigQueries = bigQueries
    metrics.queryAverageTimeMs = metricAverageTime
    metrics.counter05Sec = counter05
    metrics.counter1Sec = counter1
    metrics.counter3Sec = counter3
    metrics.counter5Sec = counter5
    metrics.counter10Sec = counter10
    metrics.counterMoreThen10Sec = counterInf
}
export { metricAverageTime, counter05, counter1, counter3, counter5, counter10, counterInf, bigQueries }

const register = new Prometheus.Registry()
const db_average_query_time_ms = new Prometheus.Gauge({
    name: 'db_average_query_time_ms',
    help: 'Average time in ms to get db query result',
    collect() {
        this.set(metricAverageTime)
    }
})
register.registerMetric(db_average_query_time_ms)

const db_query_time_counter05 = new Prometheus.Gauge({
    name: 'db_query_time_counter05',
    help: 'Counter duration of db responses less then 0.5 second',
    collect() {
        this.set(counter05)
    }
})
register.registerMetric(db_query_time_counter05)

const db_query_time_counter1 = new Prometheus.Gauge({
    name: 'db_query_time_counter1',
    help: 'Counter duration of db responses less then 1 second',
    collect() {
        this.set(counter1)
    }
})
register.registerMetric(db_query_time_counter1)

const db_query_time_counter3 = new Prometheus.Gauge({
    name: 'db_query_time_counter3',
    help: 'Counter duration of db responses less then 3 second',
    collect() {
        this.set(counter3)
    }
})
register.registerMetric(db_query_time_counter3)

const db_query_time_counter5 = new Prometheus.Gauge({
    name: 'db_query_time_counter5',
    help: 'Counter duration of db responses less then 5 second',
    collect() {
        this.set(counter5)
    }
})
register.registerMetric(db_query_time_counter5)

const db_query_time_counter10 = new Prometheus.Gauge({
    name: 'db_query_time_counter10',
    help: 'Counter duration of db responses less then 10 second',
    collect() {
        this.set(counter10)
    }
})
register.registerMetric(db_query_time_counter10)

const db_query_time_counterInf = new Prometheus.Gauge({
    name: 'db_query_time_counterInf',
    help: 'Counter duration of db responses more then 10 second',
    collect() {
        this.set(counterInf)
    }
})
register.registerMetric(db_query_time_counterInf)

const metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    includeStatusCode: true,
    includeUp: true,
    customLabels: { project_name: 'openpim', project_type: 'metrics_labels' },
    promClient: {
        collectDefaultMetrics: {
        }
    }
})

export { db_average_query_time_ms, db_query_time_counter05, db_query_time_counter1, db_query_time_counter3, db_query_time_counter5, db_query_time_counter10, db_query_time_counterInf, metricsMiddleware }

export async function SQLMetrics(request: any, response: any) {
    try {
        if (!request.headers.authorization) {
            logger.error('server.log - no login')
            response.set('WWW-Authenticate', 'Basic realm="401"')
            response.status(401).send('Authentication required.')
            return
        }
        const b64auth = request.headers.authorization.split(' ')[1]
        const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')
        const { user } = await userResolver.Mutation.signIn(null, { login: login, password: password }, await Context.create(request))
        if (user && user.roles.includes(1)) { // 1 is admin role
            response.setHeader('Content-Type', 'text/plain');
            response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            response.setHeader('Pragma', 'no-cache');
            response.setHeader('Expires', '0');
            response.setHeader('Surrogate-Control', 'no-store');
            response.status(200).json(metrics);
        } else {
            logger.error('server.log - wrong user: ' + JSON.stringify(user))
            response.set('WWW-Authenticate', 'Basic realm="401"')
            response.status(401).send('Authentication required.')
            return
        }
    } catch (error: any) {
        response.status(400).send(error.message)
    }
}