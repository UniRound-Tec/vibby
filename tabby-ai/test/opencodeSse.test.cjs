const assert = require('node:assert/strict')
const http = require('node:http')
const { OpenCodeSseClient, SseDecoder } = require('../.test-build/openCodeSse.js')

const decoded = []
const decoder = new SseDecoder(data => decoded.push(data))
decoder.push(': heartbeat\r\ndata: first')
decoder.push('\r\ndata: second\r\n\r\n')
decoder.push('data: tail')
decoder.finish()
assert.deepEqual(decoded, ['first\nsecond', 'tail'])

const waitFor = async (predicate, timeout = 4000) => {
    const deadline = Date.now() + timeout
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('timed out')
        }
        await new Promise(resolve => setTimeout(resolve, 20))
    }
}

;(async () => {
    const expectedAuth = `Basic ${Buffer.from('vibby:secret').toString('base64')}`
    let streamConnections = 0
    let statusRequests = 0
    const server = http.createServer((req, res) => {
        assert.equal(req.headers.authorization, expectedAuth)
        if (req.url.startsWith('/session/status')) {
            statusRequests++
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ root: { type: streamConnections > 1 ? 'idle' : 'busy' } }))
            return
        }
        if (req.url.startsWith('/event')) {
            streamConnections++
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                Connection: 'keep-alive',
            })
            res.write('data: {"type":"server.')
            res.write('connected","properties":{}}\n\n')
            setTimeout(() => res.end(), 30)
            return
        }
        res.statusCode = 404
        res.end()
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const events = []
    const statuses = []
    const failures = []
    const client = new OpenCodeSseClient({
        endpoint: `http://127.0.0.1:${port}`,
        username: 'vibby',
        password: 'secret',
        directory: 'C:\\repo',
        onEvent: event => events.push(event),
        onStatuses: status => statuses.push(status),
        onFailure: (error, fatal) => failures.push({ error, fatal }),
    })
    client.start()

    await waitFor(() => streamConnections >= 2 && events.length >= 2 && statuses.length >= 2)
    client.stop()
    await new Promise(resolve => server.close(resolve))

    assert.equal(failures.filter(x => x.fatal).length, 0)
    assert.equal(events[0].type, 'server.connected')
    assert.equal(statuses[0].root.type, 'busy')
    assert.equal(statuses.at(-1).root.type, 'idle')

    let unauthorizedRequests = 0
    const unauthorizedServer = http.createServer((_req, res) => {
        unauthorizedRequests++
        res.statusCode = 401
        res.end()
    })
    await new Promise(resolve => unauthorizedServer.listen(0, '127.0.0.1', resolve))
    const unauthorizedPort = unauthorizedServer.address().port
    const authFailures = []
    const unauthorizedClient = new OpenCodeSseClient({
        endpoint: `http://127.0.0.1:${unauthorizedPort}`,
        username: 'vibby',
        password: 'must-not-appear',
        onEvent: () => null,
        onStatuses: () => null,
        onFailure: (error, fatal) => authFailures.push({ error, fatal }),
    })
    unauthorizedClient.start()
    await waitFor(() => authFailures.length === 1)
    await new Promise(resolve => setTimeout(resolve, 350))
    unauthorizedClient.stop()
    await new Promise(resolve => unauthorizedServer.close(resolve))
    assert.equal(authFailures[0].fatal, true)
    assert.equal(authFailures[0].error.message.includes('must-not-appear'), false)
    assert.equal(unauthorizedRequests, 1, 'fatal authentication failures must not reconnect')

    let noAuthHeader
    const noAuthServer = http.createServer((req, res) => {
        noAuthHeader = req.headers.authorization
        if (req.url.startsWith('/session/status')) {
            res.setHeader('Content-Type', 'application/json')
            res.end('{}')
            return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"type":"server.connected","properties":{}}\n\n')
    })
    await new Promise(resolve => noAuthServer.listen(0, '127.0.0.1', resolve))
    const noAuthPort = noAuthServer.address().port
    const noAuthEvents = []
    const noAuthClient = new OpenCodeSseClient({
        endpoint: `http://127.0.0.1:${noAuthPort}`,
        onEvent: event => noAuthEvents.push(event),
        onStatuses: () => null,
    })
    noAuthClient.start()
    await waitFor(() => noAuthEvents.length === 1)
    noAuthClient.stop()
    await new Promise(resolve => noAuthServer.close(resolve))
    assert.equal(noAuthHeader, undefined)

    console.log('opencodeSse.test.cjs: all assertions passed')
})().catch(error => {
    console.error(error)
    process.exitCode = 1
})
