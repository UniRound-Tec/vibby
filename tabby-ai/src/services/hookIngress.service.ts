import * as http from 'http'
import * as crypto from 'crypto'
import { Injectable, NgZone } from '@angular/core'
import { translateClaudeHook } from '../claudeHooks'
import { CodexHookProjector } from '../codexHooks'
import { AiEventBusService } from './eventBus.service'

const BODY_LIMIT = 1024 * 1024

/**
 * Loopback HTTP ingress for hook events (docs/06-m2-plan.md §2).
 *
 * One server per window: sessions spawned by this window report here.
 * The random path token guards against other local processes (and
 * drive-by browser POSTs) guessing the endpoint. Requests are ACKed
 * before processing — hooks run blocking inside the CLI, so the wire
 * contract is "200 immediately, digest later".
 */
@Injectable({ providedIn: 'root' })
export class HookIngressService {
    private server: http.Server | null = null
    private port: number | null = null
    private token = crypto.randomBytes(16).toString('hex')
    private starting: Promise<void> | null = null
    private codexProjectors = new Map<string, CodexHookProjector>()

    constructor (
        private zone: NgZone,
        private bus: AiEventBusService,
    ) { }

    start (): Promise<void> {
        this.starting ??= new Promise<void>((resolve, reject) => {
            const server = http.createServer((req, res) => this.handle(req, res))
            server.on('error', err => {
                console.error('[tabby-ai] hook ingress failed to start', err)
                this.server = null
                reject(err)
            })
            server.listen(0, '127.0.0.1', () => {
                const address = server.address()
                if (typeof address === 'object' && address) {
                    this.server = server
                    this.port = address.port
                    console.info(`[tabby-ai] hook ingress listening on 127.0.0.1:${this.port}`)
                    resolve()
                }
            })
            // a failed attempt must not be cached as the answer forever — the
            // next session to arm gets to try again
        }).catch(err => {
            this.starting = null
            throw err
        })
        return this.starting
    }

    stop (): void {
        this.server?.close()
        this.server = null
        this.port = null
        this.starting = null
        this.codexProjectors.clear()
    }

    get running (): boolean {
        return !!this.server
    }

    /** Baked verbatim into generated hook commands — never goes through shell expansion */
    endpointFor (sessionId: string): string {
        if (!this.server) {
            throw new Error('hook ingress is not running')
        }
        return `http://127.0.0.1:${this.port}/vibby/${this.token}/event/${sessionId}`
    }

    codexEndpointFor (sessionId: string): string {
        if (!this.server) {
            throw new Error('hook ingress is not running')
        }
        return `http://127.0.0.1:${this.port}/vibby/${this.token}/codex/${sessionId}`
    }

    /**
     * Constant-time compare. The route only reaches here with 32 hex
     * characters, so the buffers are always the same length as the token.
     */
    private tokenMatches (candidate: string): boolean {
        const a = Buffer.from(candidate, 'utf8')
        const b = Buffer.from(this.token, 'utf8')
        return a.length === b.length && crypto.timingSafeEqual(a, b)
    }

    private handle (req: http.IncomingMessage, res: http.ServerResponse): void {
        const match = /^\/vibby\/([0-9a-f]{32})\/(event|codex)\/([\w-]{1,64})$/.exec(req.url ?? '')
        if (req.method !== 'POST' || !match || !this.tokenMatches(match[1])) {
            res.statusCode = 404
            res.end()
            return
        }
        const source = match[2]
        const sessionId = match[3]

        const chunks: Buffer[] = []
        let size = 0
        req.on('data', chunk => {
            size += chunk.length
            if (size > BODY_LIMIT) {
                req.destroy()
            } else {
                chunks.push(chunk)
            }
        })
        req.on('error', () => res.destroy())
        req.on('end', () => {
            res.statusCode = 200
            res.end()

            let payload: unknown = null
            try {
                payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
                console.warn('[tabby-ai] discarding malformed hook payload')
                return
            }
            const now = Date.now()
            const event = source === 'codex'
                ? this.codexProjectorFor(sessionId).apply(payload, now)
                : translateClaudeHook(sessionId, payload, now)
            if (event) {
                // http callbacks run outside Angular — re-enter for change detection
                this.zone.run(() => this.bus.publish(event))
                if (event.kind === 'session-ended') {
                    this.codexProjectors.delete(sessionId)
                }
            }
        })
    }

    private codexProjectorFor (sessionId: string): CodexHookProjector {
        let projector = this.codexProjectors.get(sessionId)
        if (!projector) {
            projector = new CodexHookProjector(sessionId)
            this.codexProjectors.set(sessionId, projector)
        }
        return projector
    }
}
