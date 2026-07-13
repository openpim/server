interface RemoteActionFetchResponse {
    json: () => Promise<unknown>
}

interface RemoteActionFetchOptions {
    method: string
    body: string
    headers: Record<string, string>
}

interface RemoteActionLogger {
    debug: (...args: any[]) => void
    error: (...args: any[]) => void
}

export interface RemoteActionReplicationOptions {
    servers?: string
    token?: string | null
    serverUuid: string
    itemId: number | string
    actionIdentifier: string
    data?: string | null
    fetch: (url: string, options: RemoteActionFetchOptions) => Promise<RemoteActionFetchResponse>
    logger: RemoteActionLogger
}

const query = `mutation ExecuteActionRemotely($itemId: ID!, $actionIdentifier: ID!, $data: String, $serverUuid: String!) {
  executeActionRemotely(itemId: $itemId, actionIdentifier: $actionIdentifier, data: $data, serverUuid: $serverUuid) {
    error
    compileError
    message
    data
  }
}`

export async function replicateAction(options: RemoteActionReplicationOptions): Promise<void> {
    if (!options.servers || !options.token) return

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
                headers: { 'Content-Type': 'application/json', 'x-token': options.token }
            })
            options.logger.debug(JSON.stringify(await response.json()))
        } catch (error) {
            options.logger.error(`Failed to execute action remotely for server ${server}`)
            options.logger.error(error)
        }
    }
}
