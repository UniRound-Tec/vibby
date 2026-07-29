import * as fs from 'fs'
import * as http from 'http'
import * as crypto from 'crypto'
import * as path from 'path'
import { Injectable, NgZone } from '@angular/core'
import { ClaudeHookProjector, translateClaudeHook } from '../claudeHooks'
import { CodexHookProjector } from '../codexHooks'
import { DROP_FILE_LIMIT, dropFileSessionId, sortDropFiles } from '../wslHookBridge'
import { translatePiHook } from '../piHooks'
import { translateKimiHook } from '../kimiHooks'
import { translateGrokHook } from '../grokHooks'
import { AiEventBusService } from './eventBus.service'

const BODY_LIMIT = 1024 * 1024
type HookSource = 'claude'|'codex'|'pi'|'kimi'|'grok'

/**
 * Cadence for the file-drop lane (WSL distros without Windows-binary
 * interop, see wslHookBridge.ts). Half the adapter's scrape interval:
 * hooks block claude for their timeout, so the payload is on disk well
 * before the turn visibly progresses, and one readdir of a tiny private
 * directory costs nothing.
 */
const DROP_POLL_MS = 300

function readDirOrEmpty (dir: string): string[] {
    try {
        return fs.readdirSync(dir)
    } catch {
        return [] // dir already cleaned up — session teardown will unregister
    }
}

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
    private claudeProjectors = new Map<string, ClaudeHookProjector>()
    private codexProjectors = new Map<string, CodexHookProjector>()
    private dropRegistrations = new Map<string, { dir: string, source: HookSource }>()
    private dropPoller: ReturnType<typeof setInterval> | null = null

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
        this.claudeProjectors.clear()
        this.codexProjectors.clear()
        this.dropRegistrations.clear()
        if (this.dropPoller) {
            clearInterval(this.dropPoller)
            this.dropPoller = null
        }
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

    piEndpointFor (sessionId: string): string {
        if (!this.server) {
            throw new Error('hook ingress is not running')
        }
        return `http://127.0.0.1:${this.port}/vibby/${this.token}/pi/${sessionId}`
    }

    kimiEndpointFor (sessionId: string): string {
        if (!this.server) {
            throw new Error('hook ingress is not running')
        }
        return `http://127.0.0.1:${this.port}/vibby/${this.token}/kimi/${sessionId}`
    }

    grokEndpointFor (sessionId: string): string {
        if (!this.server) {
            throw new Error('hook ingress is not running')
        }
        return `http://127.0.0.1:${this.port}/vibby/${this.token}/grok/${sessionId}`
    }

    /**
     * Second lane of the ingress: hook payloads arriving as files instead of
     * HTTP requests, for WSL sessions whose distro cannot reach the loopback
     * server (wslHookBridge.ts explains why that happens). Same translator,
     * same bus — only the transport differs.
     */
    registerFileDrop (sessionId: string, dir: string, source: HookSource = 'claude'): void {
        this.dropRegistrations.set(sessionId, { dir, source })
        if (!this.dropPoller) {
            // outside Angular: an empty poll must not drive change detection
            this.zone.runOutsideAngular(() => {
                this.dropPoller = setInterval(() => this.pollDropDirs(), DROP_POLL_MS)
            })
        }
    }

    unregisterFileDrop (sessionId: string): void {
        this.dropRegistrations.delete(sessionId)
        this.claudeProjectors.delete(sessionId)
        this.codexProjectors.delete(sessionId)
        if (!this.dropRegistrations.size && this.dropPoller) {
            clearInterval(this.dropPoller)
            this.dropPoller = null
        }
    }

    claudeHasActiveTools (sessionId: string): boolean {
        return this.claudeProjectors.get(sessionId)?.hasActiveTools ?? false
    }

    private pollDropDirs (): void {
        for (const dir of new Set([...this.dropRegistrations.values()].map(value => value.dir))) {
            const files: { name: string, sessionId: string, mtimeMs: number }[] = []
            for (const name of readDirOrEmpty(dir)) {
                const sessionId = dropFileSessionId(name)
                if (!sessionId) {
                    continue // an in-flight mktemp file, not yet renamed
                }
                try {
                    files.push({ name, sessionId, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs })
                } catch { /* consumed by a concurrent poll */ }
            }
            for (const file of sortDropFiles(files)) {
                this.consumeDropFile(dir, file.name, file.sessionId)
            }
        }
    }

    private consumeDropFile (dir: string, name: string, sessionId: string): void {
        const filePath = path.join(dir, name)
        let payload: unknown = null
        try {
            const stat = fs.statSync(filePath)
            if (stat.size <= DROP_FILE_LIMIT) {
                payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            } else {
                console.warn('[tabby-ai] discarding oversized hook drop file')
            }
        } catch {
            payload = null // unreadable or malformed — still consumed below
        }
        try {
            fs.unlinkSync(filePath)
        } catch {
            return // could not consume: leave processing to whoever can
        }
        const registration = this.dropRegistrations.get(sessionId)
        if (payload === null || registration?.dir !== dir) {
            return // malformed, or a leftover from a session already torn down
        }
        const now = Date.now()
        const event = this.translateHook(sessionId, payload, now, registration.source)
        if (event) {
            this.zone.run(() => this.bus.publish(event))
            if (event.kind === 'session-ended') {
                this.claudeProjectors.delete(sessionId)
                this.codexProjectors.delete(sessionId)
            }
        }
    }

    private translateHook (
        sessionId: string,
        payload: unknown,
        ts: number,
        source: HookSource,
    ): ReturnType<typeof translateClaudeHook> {
        switch (source) {
            case 'codex':
                return this.codexProjectorFor(sessionId).apply(payload, ts)
            case 'pi':
                return translatePiHook(sessionId, payload, ts)
            case 'kimi':
                return translateKimiHook(sessionId, payload, ts)
            case 'grok':
                return translateGrokHook(sessionId, payload, ts)
            default:
                return this.claudeProjectorFor(sessionId).apply(payload, ts)
        }
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
        const match = /^\/vibby\/([0-9a-f]{32})\/(event|codex|pi|kimi|grok)\/([\w-]{1,64})$/.exec(req.url ?? '')
        if (req.method !== 'POST' || !match || !this.tokenMatches(match[1])) {
            res.statusCode = 404
            res.end()
            return
        }
        const source = (match[2] === 'event' ? 'claude' : match[2]) as HookSource
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
            const event = this.translateHook(sessionId, payload, now, source)
            if (event) {
                // http callbacks run outside Angular — re-enter for change detection
                this.zone.run(() => this.bus.publish(event))
                if (event.kind === 'session-ended') {
                    this.claudeProjectors.delete(sessionId)
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

    private claudeProjectorFor (sessionId: string): ClaudeHookProjector {
        let projector = this.claudeProjectors.get(sessionId)
        if (!projector) {
            projector = new ClaudeHookProjector(sessionId)
            this.claudeProjectors.set(sessionId, projector)
        }
        return projector
    }
}
