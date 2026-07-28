import * as http from 'http'

export interface OpenCodeSseOptions {
    endpoint: string
    username?: string
    password?: string
    directory?: string|null
    onEvent: (payload: unknown) => void
    onStatuses: (payload: unknown) => void
    onConnectionChange?: (connected: boolean) => void
    onFailure?: (error: Error, fatal: boolean) => void
}

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 5000]
const REQUEST_TIMEOUT_MS = 5000
const MONITOR_PORT_MIN = 49152
const MONITOR_PORT_MAX = 65536

export function selectOpenCodeMonitorPort (
    reserved: ReadonlySet<number>,
    randomInt = (min: number, max: number): number =>
        min + Math.floor(Math.random() * (max - min)),
): number|null {
    for (let attempt = 0; attempt < 64; attempt++) {
        const candidate = randomInt(MONITOR_PORT_MIN, MONITOR_PORT_MAX)
        if (
            Number.isInteger(candidate) &&
            candidate >= MONITOR_PORT_MIN &&
            candidate < MONITOR_PORT_MAX &&
            !reserved.has(candidate)
        ) {
            return candidate
        }
    }
    return null
}

/**
 * Minimal SSE framing decoder. OpenCode sends JSON in data: fields; comments,
 * event names and ids are deliberately ignored.
 */
export class SseDecoder {
    private buffer = ''
    private data: string[] = []

    constructor (private onData: (data: string) => void) { }

    push (chunk: string): void {
        this.buffer += chunk
        for (;;) {
            const newline = this.buffer.indexOf('\n')
            if (newline < 0) {
                return
            }
            let line = this.buffer.slice(0, newline)
            this.buffer = this.buffer.slice(newline + 1)
            if (line.endsWith('\r')) {
                line = line.slice(0, -1)
            }
            if (!line) {
                this.flush()
            } else if (line.startsWith('data:')) {
                this.data.push(line.slice(5).replace(/^ /, ''))
            }
        }
    }

    finish (): void {
        if (this.buffer) {
            const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
            if (line.startsWith('data:')) {
                this.data.push(line.slice(5).replace(/^ /, ''))
            }
            this.buffer = ''
        }
        this.flush()
    }

    private flush (): void {
        if (this.data.length) {
            this.onData(this.data.join('\n'))
            this.data = []
        }
    }
}

/**
 * Authenticated OpenCode SSE connection with reconnect + status
 * reconciliation. It intentionally knows nothing about AiEvent.
 */
export class OpenCodeSseClient {
    private stopped = true
    private request: http.ClientRequest|null = null
    private reconnectTimer: any = null
    private reconnectAttempt = 0
    private connected = false

    constructor (private options: OpenCodeSseOptions) { }

    start (): void {
        if (!this.stopped) {
            return
        }
        this.stopped = false
        this.connect()
    }

    stop (): void {
        this.stopped = true
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        this.request?.destroy()
        this.request = null
        this.setConnected(false)
    }

    private connect (): void {
        if (this.stopped) {
            return
        }
        const queued: unknown[] = []
        let reconciling = true
        const decoder = new SseDecoder(data => {
            let payload: unknown = null
            try {
                payload = JSON.parse(data)
            } catch {
                return
            }
            if (reconciling) {
                queued.push(payload)
            } else {
                this.options.onEvent(payload)
            }
        })

        const url = new URL('/event', this.options.endpoint)
        if (this.apiDirectory) {
            url.searchParams.set('directory', this.apiDirectory)
        }
        const headers: http.OutgoingHttpHeaders = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
        }
        if (this.authorization) {
            headers.Authorization = this.authorization
        }
        const req = http.request(url, {
            method: 'GET',
            headers,
        })
        this.request = req
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('OpenCode event stream timed out')))
        req.on('response', response => {
            // An established SSE stream is intentionally long lived.
            req.setTimeout(0)
            if (response.statusCode === 401 || response.statusCode === 403) {
                response.resume()
                this.fail(new Error(`OpenCode authentication failed (${response.statusCode})`), true, req)
                return
            }
            if (response.statusCode !== 200) {
                response.resume()
                this.fail(new Error(`OpenCode event stream returned ${response.statusCode}`), false, req)
                return
            }

            this.reconnectAttempt = 0
            this.setConnected(true)
            response.setEncoding('utf8')
            response.on('data', chunk => decoder.push(String(chunk)))
            response.on('end', () => {
                decoder.finish()
                this.onDisconnected(req)
            })
            response.on('close', () => this.onDisconnected(req))
            response.on('error', error => this.fail(error, false, req))

            this.getJson('/session/status').then(statuses => {
                if (this.stopped) {
                    return
                }
                this.options.onStatuses(statuses)
            }).catch(error => {
                this.options.onFailure?.(error as Error, false)
            }).finally(() => {
                if (this.stopped || this.request !== req) {
                    return
                }
                reconciling = false
                for (const event of queued) {
                    this.options.onEvent(event)
                }
                queued.length = 0
            })
        })
        req.on('error', error => this.fail(error, false, req))
        req.end()
    }

    private getJson (pathname: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const url = new URL(pathname, this.options.endpoint)
            if (this.apiDirectory) {
                url.searchParams.set('directory', this.apiDirectory)
            }
            const headers: http.OutgoingHttpHeaders = { Accept: 'application/json' }
            if (this.authorization) {
                headers.Authorization = this.authorization
            }
            const req = http.request(url, {
                method: 'GET',
                headers,
            }, response => {
                const chunks: Buffer[] = []
                response.on('data', chunk => chunks.push(Buffer.from(chunk)))
                response.on('end', () => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`OpenCode ${pathname} returned ${response.statusCode}`))
                        return
                    }
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                    } catch {
                        reject(new Error(`OpenCode ${pathname} returned invalid JSON`))
                    }
                })
            })
            req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`OpenCode ${pathname} timed out`)))
            req.on('error', reject)
            req.end()
        })
    }

    private get authorization (): string|null {
        if (this.options.username === undefined || this.options.password === undefined) {
            return null
        }
        return `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`
    }

    /**
     * The launch shell/WSL resolves ~/... before the dedicated OpenCode server
     * starts. Re-sending that shorthand through the HTTP API does not expand
     * it: OpenCode creates a different ".../~" project event scope instead.
     * Omitting the query keeps the server's already-resolved working directory.
     */
    private get apiDirectory (): string|null {
        const directory = this.options.directory?.trim()
        return directory && directory !== '~' && !directory.startsWith('~/')
            ? directory
            : null
    }

    private onDisconnected (request: http.ClientRequest): void {
        if (!this.stopped && this.request === request) {
            this.request = null
            this.setConnected(false)
            this.scheduleReconnect()
        }
    }

    private fail (error: Error, fatal: boolean, request: http.ClientRequest): void {
        if (this.request !== request) {
            return
        }
        this.options.onFailure?.(error, fatal)
        request.destroy()
        this.request = null
        this.setConnected(false)
        if (fatal) {
            this.stopped = true
        } else {
            this.scheduleReconnect()
        }
    }

    private scheduleReconnect (): void {
        if (this.stopped || this.reconnectTimer) {
            return
        }
        const index = Math.min(this.reconnectAttempt++, RECONNECT_DELAYS_MS.length - 1)
        const base = RECONNECT_DELAYS_MS[index]
        const jitter = Math.floor(Math.random() * Math.max(1, base / 5))
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, base + jitter)
    }

    private setConnected (value: boolean): void {
        if (this.connected === value) {
            return
        }
        this.connected = value
        this.options.onConnectionChange?.(value)
    }
}
