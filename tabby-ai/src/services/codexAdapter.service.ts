import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Injectable, NgZone } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AppService, BaseTabComponent, ConfigService, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { CodexTrustModalComponent } from '../components/codexTrustModal.component'

import {
    CODEX_HOOK_DROP_DIR_ENV,
    CODEX_HOOK_ENDPOINT_ENV,
    CODEX_HOOK_SESSION_ENV,
    CODEX_PROFILE_NAME,
    codexHookProfile,
    injectCodexLaunchArgs,
} from '../codexHooks'
import { clampSummary } from '../events'
import { SHIM_DIR_PREFIX } from '../paths'
import {
    appendWslenv,
    translateWindowsPathForWsl,
    translateWindowsPathWithMountRoot,
} from '../runtimeTargets'
import { CliScannerService } from './cliScanner.service'
import { AiEventBusService } from './eventBus.service'
import { HookIngressService } from './hookIngress.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { TerminalCliShimInstallation, TerminalCliShimService } from './terminalCliShim.service'
import { whenSplitInitialized } from '../whenSplitInitialized'

const KIND = 'codex'
const SCRAPE_INTERVAL_MS = 600
const EXIT_GRACE_MS = 500
const LEGACY_REMOTE_TOKEN_PREFIX = 'VIBBY_CODEX_REMOTE_TOKEN_'
/**
 * Hooks Codex has not seen before are skipped silently — no error, no log, the
 * session just never reports. Rather than make every user answer a trust
 * prompt, vibby vouches for the profile it wrote itself. The cost is that
 * Codex's review is skipped for every hook source it loads, so arming says so
 * once (see notifyTrustBypass).
 */
const CODEX_TRUST_BYPASS_FLAG = '--dangerously-bypass-hook-trust'
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

/**
 * Read again through a call boundary: control flow analysis keeps the
 * earlier `if (tab.session)` narrowing alive across the ingress await and
 * would call an inline recheck dead — but the getter really can change.
 */
function sessionAppeared (tab: TerminalTabComponent): boolean {
    return !!tab.session
}

/** A profile the user asked for themselves — Codex honours only one. */
function selectsOwnProfile (args: string[]): boolean {
    return args.some(arg =>
        arg === '-p' || arg === '--profile' || arg.startsWith('--profile='),
    )
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
            (args[i] === '-p' || args[i] === '--profile') &&
            args[i + 1] === CODEX_PROFILE_NAME
        ) {
            i++
        } else if (
            args[i] === `--profile=${CODEX_PROFILE_NAME}` ||
            args[i] === CODEX_TRUST_BYPASS_FLAG
        ) {
            continue
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

/** Where Codex looks for `<profile>.config.toml` — an empty override is no override */
function codexHome (): string {
    const configured = process.env.CODEX_HOME?.trim()
    return configured ? configured : path.join(os.homedir(), '.codex')
}

function withoutStaleHookEnv (env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) =>
            key !== CODEX_HOOK_ENDPOINT_ENV &&
            key !== CODEX_HOOK_DROP_DIR_ENV &&
            key !== CODEX_HOOK_SESSION_ENV &&
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
    private scraper: ReturnType<typeof setInterval>|null = null
    private trustBypassAnnounced = false

    constructor (
        private app: AppService,
        private scanner: CliScannerService,
        private ingress: HookIngressService,
        private terminalShim: TerminalCliShimService,
        private directory: AiSessionDirectoryService,
        private bus: AiEventBusService,
        private config: ConfigService,
        private ngbModal: NgbModal,
        private zone: NgZone,
    ) {}

    activate (): void {
        // Get the listener up before any pane arms. arm() has to await it to
        // learn the port, and that await is the window the session can spawn in.
        this.ingress.start().catch(() => null)
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
                void whenSplitInitialized(tab).then(() =>
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
        const direct = tab.profile.type === 'ai-cli'
        const kind = direct ? tab.profile.options['aiCli']?.kind : KIND
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
        // Injection rewrites the profile the session is spawned from, so a pane
        // that already has one is out of reach — but leave it unarmed. Marking
        // it here burns the tab for good, and `visit` runs again on every tab
        // change: a pane whose session is later replaced deserves another look.
        if (tab.session) {
            return
        }
        this.armed.add(tab)
        try {
            await this.ingress.start()
        } catch (error) {
            console.warn('[tabby-ai] Codex hook ingress unavailable', error)
            return
        }
        // ingress.start() yields, and the session can spawn in that window
        if (sessionAppeared(tab)) {
            console.warn('[tabby-ai] Codex session spawned before hook injection; full support skipped')
            return
        }

        const sessionId = crypto.randomUUID()
        const originalArgs = withoutStaleHookConfig([...tab.profile.options.args])
        const originalEnv = withoutStaleHookEnv({ ...tab.profile.options.env })
        const targetId = tab.profile.options['aiCli']?.targetId
        const wslTarget = direct
            ? this.scanner.runtimeTargets.find(target => target.id === targetId && target.type === 'wsl')
            : null
        const wslDetection = wslTarget?.type === 'wsl'
            ? this.scanner.scanResults.find(item =>
                item.entry.id === KIND &&
                item.target.id === wslTarget.id,
            )
            : null
        if (wslTarget?.type === 'wsl' && wslDetection?.monitoring !== 'full') {
            console.warn(`[tabby-ai] Codex hooks unavailable in ${wslTarget.distro}; launching without full monitoring`)
            return
        }
        if (!wslTarget && !this.writeHookProfile()) {
            return
        }
        // Codex keeps only one profile, and the user's own choice is the one
        // that carries their model and provider settings — take launch-only
        // monitoring over silently dropping it.
        if (selectsOwnProfile(originalArgs)) {
            console.warn('[tabby-ai] Codex launched with its own --profile; hook monitoring skipped')
            return
        }
        const injectedArgs = ['-p', CODEX_PROFILE_NAME, CODEX_TRUST_BYPASS_FLAG]
        this.notifyTrustBypass()
        let shim: TerminalCliShimInstallation|null = null
        let tempRoot: string|null = null
        if (direct) {
            const launchedArgs = injectCodexLaunchArgs(
                originalArgs,
                injectedArgs,
                wslTarget?.type === 'wsl',
            )
            if (!launchedArgs) {
                console.warn('[tabby-ai] malformed WSL Codex launch; hook monitoring skipped')
                return
            }
            const injectedEnv: Record<string, string> = {
                [CODEX_HOOK_ENDPOINT_ENV]: this.ingress.codexEndpointFor(sessionId),
            }
            if (wslTarget?.type === 'wsl') {
                try {
                    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibby-codex-'))
                } catch (error) {
                    console.warn('[tabby-ai] could not create the WSL Codex hook drop directory', error)
                    return
                }
                const translatedDrop = wslTarget.windowsMountRoot
                    ? translateWindowsPathWithMountRoot(wslTarget.windowsMountRoot, tempRoot)
                    : await translateWindowsPathForWsl(wslTarget, tempRoot)
                if (sessionAppeared(tab) || !translatedDrop) {
                    this.removeTempRoot(tempRoot)
                    console.warn(`[tabby-ai] WSL hook bridge unavailable in ${wslTarget.distro}; Codex will launch without full monitoring`)
                    return
                }
                injectedEnv[CODEX_HOOK_DROP_DIR_ENV] = translatedDrop
                injectedEnv[CODEX_HOOK_SESSION_ENV] = sessionId
                injectedEnv['WSLENV'] = appendWslenv(
                    originalEnv['WSLENV'] || process.env.WSLENV,
                    [CODEX_HOOK_DROP_DIR_ENV, CODEX_HOOK_SESSION_ENV],
                )
                this.ingress.registerFileDrop(sessionId, tempRoot, 'codex')
            }
            tab.profile.options.args = launchedArgs
            tab.profile.options.env = {
                ...originalEnv,
                ...injectedEnv,
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
                    injectedArgs,
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

        // Codex defers its SessionStart hook to the start of the first turn
        // (core/src/session/turn.rs — run_pending_session_start_hooks runs
        // inside run_turn), so a pane sitting at the composer never reports and
        // would stay invisible on the dashboard until the user sends something.
        // Claude fires its own at startup and needs no help. Only the dedicated
        // pane can claim this: under the shim any terminal could be armed, and
        // one is a Codex session only once a hook actually arrives.
        if (direct) {
            this.zone.run(() => this.bus.publish({
                sessionId,
                ts: Date.now(),
                kind: 'session-started',
                confidence: 'low',
                summary: 'ready',
            }))
        }

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

    /**
     * Rewritten on every arm rather than once: the file lives in the user's
     * Codex home, where an edit or a stale copy from an older vibby would
     * otherwise persist. Content is fixed, so the trust hash still holds.
     */
    private writeHookProfile (): boolean {
        try {
            const home = codexHome()
            fs.mkdirSync(home, { recursive: true })
            fs.writeFileSync(
                path.join(home, `${CODEX_PROFILE_NAME}.config.toml`),
                codexHookProfile(),
                { mode: 0o600 },
            )
            return true
        } catch (error) {
            console.warn('[tabby-ai] could not write the Codex hook profile', error)
            return false
        }
    }

    /** Shown once ever — the first arm records it and it never comes back */
    private notifyTrustBypass (): void {
        if (this.trustBypassAnnounced || this.config.store.aiCli.codex.trustBypassAcknowledged) {
            return
        }
        this.trustBypassAnnounced = true
        this.config.store.aiCli.codex.trustBypassAcknowledged = true
        this.config.save()
        this.zone.run(() => {
            this.ngbModal.open(CodexTrustModalComponent, { backdrop: 'static' }).result
                .catch(() => null)
        })
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
            const snapshot = this.bus.snapshotFor(sessionId)
            if (snapshot?.state !== 'working') {
                continue
            }
            const status = this.readStatusLine(pane)
            // Compared against what the bus already holds rather than a cache of
            // our own. The bus drops liveStatus on the way out of `working`, so
            // a cache that outlives the turn suppresses the next one: Codex
            // captions repeat verbatim between turns once the elapsed-time
            // suffix is stripped, and the second turn would never publish.
            if (status && clampSummary(status) !== snapshot.liveStatus) {
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
        this.ingress.unregisterFileDrop(run.sessionId)
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
