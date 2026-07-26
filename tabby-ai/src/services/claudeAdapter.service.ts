import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { HOOK_DIR_PREFIX, SHIM_DIR_PREFIX, holdsOnlyGeneratedFiles, isHookDirName } from '../paths'
import { CliScannerService } from './cliScanner.service'
import { AiEventBusService } from './eventBus.service'
import { HookIngressService } from './hookIngress.service'
import { TerminalCliShimInstallation, TerminalCliShimService } from './terminalCliShim.service'

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd']

/**
 * Session markers claude sets in its own environment. If vibby itself was
 * launched from inside a claude session (dev workflows, terminals spawned
 * by agents), children would inherit them and misdetect a nested session
 * ("Transcript saving is off"). ANTHROPIC_* stays — that's user config.
 */
const CLAUDE_ENV_MARKERS = [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
]

/**
 * claude's own status line: `✻ Flambéing… (17s · ↓ 1.2k tokens · esc to interrupt)`.
 * Unicode-aware on purpose — the vocabulary is full of accents (Flambéing, Nöödling).
 */
const SPINNER_RE = /(\p{Lu}[\p{L}'’-]{2,24})(?:…|\.{3})\s*\((\d+[smh][^)]{0,60})\)/u

/** Trailing hint claude appends inside the parens */
const SPINNER_HINT_RE = /\s*·\s*(esc|ctrl)\b.*$/i

/** Status-line poll while a session is working — fast enough to look live, cheap enough to ignore */
const SCRAPE_INTERVAL_MS = 600

/** SessionEnd hook may still be in flight when the PTY dies — wait before calling it a crash */
const EXIT_GRACE_MS = 1500

function readDirOrEmpty (dir: string): string[] {
    try {
        return fs.readdirSync(dir)
    } catch {
        return []
    }
}

/**
 * Claude Code event adapter (docs/06-m2-plan.md §3).
 *
 * Injection rides app.tabOpened$: it fires synchronously on tab creation
 * (fresh launches, recovered tabs and duplicates all pass through
 * openNewTabRaw), while the PTY only spawns later in onFrontendReady —
 * so mutating profile.options here is guaranteed to land before spawn,
 * and `--settings` never needs to survive in stored profiles.
 *
 * Recovery tokens do persist tab.profile including our injected args,
 * which is exactly why arming strips any stale `--settings <...vibby-hooks...>`
 * pair before appending a fresh one.
 */
@Injectable({ providedIn: 'root' })
export class ClaudeAdapterService {
    private sessionIds = new WeakMap<TerminalTabComponent, string>()
    private sessionKinds = new WeakMap<TerminalTabComponent, string>()
    private panes = new Map<string, TerminalTabComponent>()
    private armed = new WeakSet<TerminalTabComponent>()
    private watchedSplits = new WeakSet<SplitTabComponent>()
    /** Created on first use by ensureInjectDir(), never at construction */
    private injectDir: string | null = null
    private scraper: any = null
    private lastStatus = new Map<string, string>()
    private shimInstallations = new WeakMap<TerminalTabComponent, TerminalCliShimInstallation>()

    constructor (
        private app: AppService,
        private ingress: HookIngressService,
        private bus: AiEventBusService,
        private zone: NgZone,
        private scanner: CliScannerService,
        private terminalShim: TerminalCliShimService,
    ) { }

    activate (): void {
        this.cleanupStaleFiles()
        this.app.tabOpened$.subscribe(tab => this.visit(tab))
        // belt-and-braces sweep: arming is idempotent, late discoveries warn+skip
        this.app.tabsChanged$.subscribe(() => {
            for (const tab of this.app.tabs) {
                this.visit(tab)
            }
        })
        for (const tab of this.app.tabs) {
            this.visit(tab)
        }
    }

    /** Dashboard join: which bus session does this pane report as */
    sessionIdForPane (pane: BaseTabComponent, kind?: string|null): string | null {
        if (!(pane instanceof TerminalTabComponent) || kind && this.sessionKinds.get(pane) !== kind) {
            return null
        }
        return this.sessionIds.get(pane) ?? null
    }

    /** Reverse lookup for notification click-through */
    paneForSessionId (sessionId: string): TerminalTabComponent | null {
        return this.panes.get(sessionId) ?? null
    }

    private visit (tab: BaseTabComponent): void {
        if (tab instanceof SplitTabComponent) {
            if (!this.watchedSplits.has(tab)) {
                this.watchedSplits.add(tab)
                tab.tabAdded$.subscribe(child => this.visit(child))
                // recovered children never emit tabAdded$ (recoverContainer calls
                // attachTabView directly) — sweep once recovery has finished,
                // which is still before any child's frontend-ready spawn
                tab.initialized$.toPromise().then(() => {
                    for (const child of tab.getAllTabs()) {
                        this.visit(child)
                    }
                })
            }
            for (const child of tab.getAllTabs()) {
                this.visit(child)
            }
        } else if (tab instanceof TerminalTabComponent) {
            this.arm(tab)
        }
    }

    private async arm (tab: TerminalTabComponent): Promise<void> {
        if (this.armed.has(tab)) {
            return
        }
        const isDirectLaunch = tab.profile?.type === 'ai-cli'
        const kind = isDirectLaunch
            ? tab.profile.options?.['aiCli']?.kind
            : 'claude-code'
        // Adapter ownership is explicit: future full-tier CLIs get their own
        // event translator while reusing TerminalCliShimService.
        if (kind !== 'claude-code') {
            return
        }
        const detected = isDirectLaunch
            ? null
            : this.scanner.scanResults.find(item => item.entry.id === kind) ?? null
        if (!isDirectLaunch && !detected) {
            return
        }
        this.armed.add(tab)

        await this.ingress.start()
        if (tab.session) {
            // spawn beat us to it — never inject into a live session's options
            console.warn('[tabby-ai] session spawned before hook injection, skipping', kind)
            return
        }

        const sessionId = crypto.randomUUID()
        const written = this.writeHookSettings(sessionId)
        if (!written) {
            return
        }
        const { injectDir, settingsPath } = written

        if (isDirectLaunch) {
            const args = (tab.profile.options.args ?? []).slice()
            for (let i = args.length - 2; i >= 0; i--) {
                if (args[i] === '--settings' && String(args[i + 1]).includes(HOOK_DIR_PREFIX)) {
                    args.splice(i, 2)
                }
            }
            args.push('--settings', settingsPath)
            tab.profile.options.args = args
        } else {
            const shimDirectory = path.join(injectDir, `${SHIM_DIR_PREFIX}${process.pid}-${sessionId}`)
            try {
                this.shimInstallations.set(tab, this.terminalShim.install(
                    tab,
                    detected!,
                    shimDirectory,
                    ['--settings', settingsPath],
                ))
            } catch (error) {
                try {
                    fs.unlinkSync(settingsPath)
                } catch { /* already gone */ }
                console.error('[tabby-ai] could not install terminal CLI shim, session will use process detection', error)
                return
            }
        }

        // empty string beats any inherited value in mergeEnv and reads as unset
        const envOverrides = Object.fromEntries(CLAUDE_ENV_MARKERS.map(k => [k, '']))
        tab.profile.options.env = { ...tab.profile.options.env, ...envOverrides }

        this.sessionIds.set(tab, sessionId)
        this.sessionKinds.set(tab, kind)
        this.panes.set(sessionId, tab)
        this.startScraper()

        tab.sessionChanged$.subscribe(session => {
            console.debug(`[tabby-ai] adapter [${sessionId.slice(0, 8)}] sessionChanged: ${session ? 'live' : 'null'}`)
            session?.destroyed$.subscribe(() => {
                console.debug(`[tabby-ai] adapter [${sessionId.slice(0, 8)}] session destroyed`)
                this.onSessionDown(sessionId)
            })
        })
        tab.destroyed$.subscribe(() => {
            try {
                fs.unlinkSync(settingsPath)
            } catch { /* already gone */ }
            this.shimInstallations.get(tab)?.remove()
            this.panes.delete(sessionId)
            this.lastStatus.delete(sessionId)
            this.stopScraperIfIdle()
            this.zone.run(() => this.bus.dropSession(sessionId))
        })
    }

    /**
     * Live caption between hook events (plan §9 channel ②).
     *
     * Reads the *rendered* screen, never the PTY stream: claude repaints its
     * status line differentially (it rewrites only changed cells and jumps the
     * cursor between them), so `Spelunking…` arrives on the wire as
     * `g✶Spelunkn✻✽i…kg✻nn✶ui…` — unrecoverable by any regex. Only xterm's
     * buffer holds the phrase in reading order.
     *
     * Low confidence by design: fills the caption, never the state.
     */
    private startScraper (): void {
        if (this.scraper) {
            return
        }
        // outside Angular: a 600ms tick must not drive app-wide change detection
        this.zone.runOutsideAngular(() => {
            this.scraper = setInterval(() => this.scrapeOnce(), SCRAPE_INTERVAL_MS)
        })
    }

    /** The last monitored pane is gone — nothing left to read */
    private stopScraperIfIdle (): void {
        if (this.scraper && this.panes.size === 0) {
            clearInterval(this.scraper)
            this.scraper = null
        }
    }

    private scrapeOnce (): void {
        // the caption is cosmetic and the screen is not being painted; state
        // still arrives over the hook channel, so notifications keep working
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

    /** Bottom-up scan of the visible rows — the freshest status line wins */
    private readStatusLine (pane: TerminalTabComponent): string | null {
        const xterm = (pane.frontend as { xterm?: any } | undefined)?.xterm
        const buffer = xterm?.buffer?.active
        if (!buffer) {
            return null
        }
        // anchor on baseY, not viewportY: scrolling back must not freeze the caption
        for (let y = buffer.baseY + (xterm.rows ?? 24) - 1; y >= buffer.baseY; y--) {
            const line = buffer.getLine(y)?.translateToString(true)
            if (!line) {
                continue
            }
            const match = SPINNER_RE.exec(line)
            if (match) {
                return `${match[1]}… (${match[2].replace(SPINNER_HINT_RE, '')})`
            }
        }
        return null
    }

    /** PTY died: crash unless a SessionEnd hook explains it within the grace window */
    private onSessionDown (sessionId: string): void {
        setTimeout(() => {
            const snapshot = this.bus.snapshotFor(sessionId)
            console.debug(`[tabby-ai] adapter [${sessionId.slice(0, 8)}] exit verdict, lastEvent: ${snapshot?.lastEvent?.kind ?? 'none'}`)
            if (snapshot && snapshot.lastEvent?.kind !== 'session-ended') {
                this.zone.run(() => this.bus.publish({
                    sessionId,
                    ts: Date.now(),
                    kind: 'process-exited',
                    confidence: 'high',
                    summary: 'process exited',
                }))
            }
        }, EXIT_GRACE_MS)
    }

    private settingsFor (sessionId: string): unknown {
        // values are baked in as literals — never rely on shell variable expansion (§2)
        const command = `curl -s -m 3 --data-binary @- "${this.ingress.endpointFor(sessionId)}"`
        const hooks: Record<string, unknown> = {}
        for (const event of HOOK_EVENTS) {
            hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
        }
        return { hooks }
    }

    /**
     * One directory per process, created on first arm().
     *
     * mkdtemp rather than a fixed name under os.tmpdir(): on POSIX that is the
     * shared /tmp, and a predictable name lets another local user own the
     * directory before we get there. They would then be able to swap out the
     * shim directory we prepend to the session's PATH. mkdtemp gives us 0700
     * and an unguessable suffix in one call.
     */
    private ensureInjectDir (): string {
        this.injectDir ??= fs.mkdtempSync(path.join(os.tmpdir(), `${HOOK_DIR_PREFIX}-`))
        return this.injectDir
    }

    /** null when the session has to go unmonitored */
    private writeHookSettings (sessionId: string): { injectDir: string, settingsPath: string } | null {
        try {
            const injectDir = this.ensureInjectDir()
            const settingsPath = path.join(injectDir, `${process.pid}-${sessionId}.json`)
            // 0600: the file carries the ingress token
            fs.writeFileSync(settingsPath, JSON.stringify(this.settingsFor(sessionId), null, 2), { mode: 0o600 })
            return { injectDir, settingsPath }
        } catch (error) {
            console.error('[tabby-ai] could not write hook settings, session will be unmonitored', error)
            return null
        }
    }

    /** Drops hook directories left behind by processes that did not exit cleanly */
    private cleanupStaleFiles (): void {
        const cutoff = Date.now() - 24 * 3600 * 1000
        for (const name of readDirOrEmpty(os.tmpdir())) {
            if (!isHookDirName(name)) {
                continue
            }
            const dir = path.join(os.tmpdir(), name)
            try {
                // lstat, not stat: never follow a symlink planted in a shared /tmp
                const stat = fs.lstatSync(dir)
                if (!stat.isDirectory() || stat.mtimeMs >= cutoff || dir === this.injectDir) {
                    continue
                }
                // the name alone cannot prove the directory is ours, and this
                // is a recursive delete — let the contents confirm it
                if (holdsOnlyGeneratedFiles(fs.readdirSync(dir))) {
                    fs.rmSync(dir, { recursive: true, force: true })
                }
            } catch { /* raced another instance's cleanup */ }
        }
    }
}
