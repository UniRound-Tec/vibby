import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { CODEX_HOOK_ENDPOINT_ENV, codexHookConfig } from '../codexHooks'
import { SHIM_DIR_PREFIX } from '../paths'
import { CliScannerService } from './cliScanner.service'
import { AiEventBusService } from './eventBus.service'
import { HookIngressService } from './hookIngress.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { TerminalCliShimInstallation, TerminalCliShimService } from './terminalCliShim.service'

const KIND = 'codex'
const SCRAPE_INTERVAL_MS = 600
const EXIT_GRACE_MS = 500
const LEGACY_REMOTE_TOKEN_PREFIX = 'VIBBY_CODEX_REMOTE_TOKEN_'
const PASSTHROUGH_SUBCOMMANDS = [
    'app',
    'app-server',
    'completion',
    'doctor',
    'features',
    'mcp-server',
    'remote-control',
    'update',
]

interface CodexRun {
    tab: TerminalTabComponent
    sessionId: string
    direct: boolean
    shim: TerminalCliShimInstallation|null
    tempRoot: string|null
    disposed: boolean
}

function withoutStaleHookConfig (args: string[]): string[] {
    const legacyBridge = args.some((arg, index) =>
        arg === '--remote-auth-token-env' &&
            args[index + 1]?.startsWith(LEGACY_REMOTE_TOKEN_PREFIX) ||
        arg.startsWith('--remote-auth-token-env=') &&
            arg.slice(arg.indexOf('=') + 1).startsWith(LEGACY_REMOTE_TOKEN_PREFIX),
    )
    const clean: string[] = []
    for (let i = 0; i < args.length; i++) {
        if (
            args[i] === '-c' &&
            typeof args[i + 1] === 'string' &&
            args[i + 1].includes(CODEX_HOOK_ENDPOINT_ENV)
        ) {
            i++
        } else if (
            legacyBridge &&
            (args[i] === '--remote' || args[i] === '--remote-auth-token-env')
        ) {
            i++
        } else if (
            legacyBridge &&
            (args[i].startsWith('--remote=') || args[i].startsWith('--remote-auth-token-env='))
        ) {
            continue
        } else {
            clean.push(args[i])
        }
    }
    return clean
}

function withoutStaleHookEnv (env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) =>
            key !== CODEX_HOOK_ENDPOINT_ENV &&
            !key.startsWith(LEGACY_REMOTE_TOKEN_PREFIX),
        ),
    )
}

/**
 * Codex monitoring mirrors the Claude adapter: hooks own reliable state
 * boundaries, while rendered terminal status is a low-confidence caption.
 */
@Injectable({ providedIn: 'root' })
export class CodexAdapterService {
    private armed = new WeakSet<TerminalTabComponent>()
    private watchedSplits = new WeakSet<SplitTabComponent>()
    private runs = new WeakMap<TerminalTabComponent, CodexRun>()
    private panes = new Map<string, TerminalTabComponent>()
    private lastStatus = new Map<string, string>()
    private scraper: ReturnType<typeof setInterval>|null = null

    constructor (
        private app: AppService,
        private scanner: CliScannerService,
        private ingress: HookIngressService,
        private terminalShim: TerminalCliShimService,
        private directory: AiSessionDirectoryService,
        private bus: AiEventBusService,
        private zone: NgZone,
    ) {}

    activate (): void {
        this.app.tabOpened$.subscribe(tab => this.visit(tab))
        this.app.tabsChanged$.subscribe(() => this.app.tabs.forEach(tab => this.visit(tab)))
        this.scanner.scanResults$.subscribe(() => this.app.tabs.forEach(tab => this.visit(tab)))
        this.app.tabs.forEach(tab => this.visit(tab))
    }

    private visit (tab: BaseTabComponent): void {
        if (tab instanceof SplitTabComponent) {
            if (!this.watchedSplits.has(tab)) {
                this.watchedSplits.add(tab)
                tab.tabAdded$.subscribe(child => this.visit(child))
                tab.initialized$.toPromise().then(() =>
                    tab.getAllTabs().forEach(child => this.visit(child)),
                )
            }
            tab.getAllTabs().forEach(child => this.visit(child))
        } else if (tab instanceof TerminalTabComponent) {
            void this.arm(tab)
        }
    }

    private async arm (tab: TerminalTabComponent): Promise<void> {
        if (this.armed.has(tab)) {
            return
        }
        const direct = tab.profile?.type === 'ai-cli'
        const kind = direct ? tab.profile.options?.['aiCli']?.kind : KIND
        if (kind !== KIND) {
            return
        }
        const detected = direct ? null : this.scanner.scanResults.find(item =>
            item.entry.id === KIND &&
            item.target.type === 'native' &&
            item.monitoring === 'full',
        ) ?? null
        if (!direct && !detected) {
            return
        }
        this.armed.add(tab)
        try {
            await this.ingress.start()
        } catch (error) {
            console.warn('[tabby-ai] Codex hook ingress unavailable', error)
            return
        }
        if (tab.session) {
            console.warn('[tabby-ai] Codex session spawned before hook injection; full support skipped')
            return
        }

        const sessionId = crypto.randomUUID()
        const originalArgs = withoutStaleHookConfig([...tab.profile.options.args ?? []])
        const originalEnv = withoutStaleHookEnv({ ...tab.profile.options.env ?? {} })
        let shim: TerminalCliShimInstallation|null = null
        let tempRoot: string|null = null
        if (direct) {
            tab.profile.options.args = ['-c', codexHookConfig(), ...originalArgs]
            tab.profile.options.env = {
                ...originalEnv,
                [CODEX_HOOK_ENDPOINT_ENV]: this.ingress.codexEndpointFor(sessionId),
            }
        } else {
            try {
                tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibby-codex-'))
                const shimDirectory = path.join(
                    tempRoot,
                    `${SHIM_DIR_PREFIX}${process.pid}-${sessionId}`,
                )
                shim = this.terminalShim.install(
                    tab,
                    detected!,
                    shimDirectory,
                    ['-c', codexHookConfig()],
                    { [CODEX_HOOK_ENDPOINT_ENV]: this.ingress.codexEndpointFor(sessionId) },
                    PASSTHROUGH_SUBCOMMANDS,
                )
            } catch (error) {
                if (tempRoot) {
                    this.removeTempRoot(tempRoot)
                }
                console.warn('[tabby-ai] could not install Codex hook shim', error)
                return
            }
        }

        const run: CodexRun = {
            tab,
            sessionId,
            direct,
            shim,
            tempRoot,
            disposed: false,
        }
        this.runs.set(tab, run)
        this.directory.bind({ sessionId, kind: KIND, pane: tab })
        this.panes.set(sessionId, tab)
        this.startScraper()

        const attachSession = (session: TerminalTabComponent['session']): void => {
            if (!session) {
                return
            }
            session.destroyed$.subscribe(() => this.onSessionDown(run))
        }
        tab.sessionChanged$.subscribe(attachSession)
        attachSession(tab.session)
        tab.destroyed$.subscribe(() => this.dispose(run))
    }

    private startScraper (): void {
        if (this.scraper) {
            return
        }
        this.zone.runOutsideAngular(() => {
            this.scraper = setInterval(() => this.scrapeOnce(), SCRAPE_INTERVAL_MS)
        })
    }

    private scrapeOnce (): void {
        if (document.hidden) {
            return
        }
        for (const [sessionId, pane] of this.panes) {
            if (this.bus.snapshotFor(sessionId)?.state !== 'working') {
                continue
            }
            const status = this.readStatusLine(pane)
            if (status && status !== this.lastStatus.get(sessionId)) {
                this.lastStatus.set(sessionId, status)
                this.zone.run(() => this.bus.setLiveStatus(sessionId, status))
            }
        }
    }

    private readStatusLine (pane: TerminalTabComponent): string|null {
        const xterm = (pane.frontend as { xterm?: any }|undefined)?.xterm
        const buffer = xterm?.buffer?.active
        if (!buffer) {
            return null
        }
        for (let y = buffer.baseY + (xterm.rows ?? 24) - 1; y >= buffer.baseY; y--) {
            const line = buffer.getLine(y)?.translateToString(true)?.trim()
            if (!line || !/esc to interrupt/i.test(line)) {
                continue
            }
            return line
                .replace(/^[\u2800-\u28ff•◦]\s*/, '')
                .replace(/\s*\([^)]*esc to interrupt[^)]*\)\s*$/i, '')
                .trim() || null
        }
        return null
    }

    private onSessionDown (run: CodexRun): void {
        setTimeout(() => {
            const snapshot = this.bus.snapshotFor(run.sessionId)
            if (snapshot && snapshot.lastEvent?.kind !== 'session-ended') {
                this.zone.run(() => this.bus.publish({
                    sessionId: run.sessionId,
                    ts: Date.now(),
                    kind: 'process-exited',
                    confidence: 'high',
                    summary: 'Codex exited',
                }))
            }
        }, EXIT_GRACE_MS)
    }

    private dispose (run: CodexRun): void {
        if (run.disposed) {
            return
        }
        run.disposed = true
        run.shim?.remove()
        if (run.tempRoot) {
            this.removeTempRoot(run.tempRoot)
        }
        this.panes.delete(run.sessionId)
        this.lastStatus.delete(run.sessionId)
        this.directory.unbind(run.sessionId)
        this.zone.run(() => this.bus.dropSession(run.sessionId))
        if (this.scraper && this.panes.size === 0) {
            clearInterval(this.scraper)
            this.scraper = null
        }
    }

    private removeTempRoot (directory: string): void {
        const resolved = path.resolve(directory)
        if (
            path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
            !path.basename(resolved).startsWith('vibby-codex-')
        ) {
            console.warn('[tabby-ai] refusing to remove unexpected Codex temp directory')
            return
        }
        try {
            fs.rmSync(resolved, { recursive: true, force: true })
        } catch { /* already gone */ }
    }
}
