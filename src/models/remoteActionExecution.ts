interface RemoteActionFetchResponse {
    ok: boolean
    status: number
    json: () => Promise<{ data?: unknown, errors?: unknown }>
}

interface RemoteActionFetchOptions {
    method: string
    body: string
    headers: Record<string, string>
    timeout: number
}

interface RemoteActionLogger {
    debug: (...args: any[]) => void
    error: (...args: any[]) => void
}

export interface RemoteActionExecutionOptions {
    servers?: string
    token?: string | null
    serverUuid: string
    itemId: number | string
    actionIdentifier: string
    data?: string | null
    isRemoteExecution: boolean
    fetch: (url: string, options: RemoteActionFetchOptions) => Promise<RemoteActionFetchResponse>
    logger: RemoteActionLogger
}

const timeout = 10000

const query = `mutation ExecuteAction($itemId: ID!, $actionIdentifier: ID!, $data: String, $serverUuid: String!) {
  executeAction(itemId: $itemId, actionIdentifier: $actionIdentifier, data: $data, serverUuid: $serverUuid) {
    error
    compileError
    message
    data
  }
}`

export async function executeActionOnRemoteServers(options: RemoteActionExecutionOptions): Promise<void> {
    if (options.isRemoteExecution || !options.servers || !options.token) return

    const servers = options.servers.split(';').map(server => server.trim()).filter(Boolean)
    for (const server of servers) {
        options.logger.debug(`Executing action remotely for server ${server}`)
        try {
            const response = await options.fetch(server + '/graphql', {
                method: 'post',
                body: JSON.stringify({
                    query,
                    variables: {
                        itemId: options.itemId,
                        actionIdentifier: options.actionIdentifier,
                        data: options.data,
                        serverUuid: options.serverUuid
                    }
                }),
                headers: { 'Content-Type': 'application/json', 'x-token': options.token },
                timeout
            })
            const body = await response.json()
            if (!response.ok) throw new Error(`Remote server responded with HTTP ${response.status}`)
            if (body.errors) throw new Error(`Remote action failed: ${JSON.stringify(body.errors)}`)
            options.logger.debug(JSON.stringify(body))
        } catch (error) {
            options.logger.error(`Failed to execute action remotely for server ${server}`)
            options.logger.error(error)
        }
    }
}
