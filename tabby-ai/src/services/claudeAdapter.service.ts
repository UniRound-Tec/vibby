import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'
import { BaseSession } from 'tabby-terminal'

import { DetectedCli, WslCliRuntimeTarget } from '../api'
import {
    CLAUDE_HOOK_EVENTS,
    CLAUDE_HOOK_SESSION_ENV,
    CLAUDE_HOOK_TEMP_ENV,
    claudeHookRecovery,
} from '../claudeHooks'
import { claudeEnvironmentOverrides } from '../claudeEnvironment'
import { spinnerAbsenceEndsTurn } from '../events'
import {
    DROP_DIR_NAME, HOOK_DIR_PREFIX, SHIM_DIR_PREFIX, holdsOnlyGeneratedFiles, isHookDirName, isLegacyHookDirName,
    ownerPids, quoteSh,
} from '../paths'
import {
    translateWindowsPathForWsl, translateWindowsPathWithMountRoot, windowsExecutableRunsInWsl,
} from '../runtimeTargets'
import {
    selectWslHookTransport, windowsDropHookCommand, wslDropHookCommand,
} from '../wslHookBridge'
import { CliScannerService } from './cliScanner.service'
import { AiEventBusService } from './eventBus.service'
import { HookIngressService } from './hookIngress.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { TerminalCliShimInstallation, TerminalCliShimService } from './terminalCliShim.service'

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

/**
 * Backoff between ingress start attempts. Injection has to land before the
 * PTY spawns on frontend-ready, so the whole budget is deliberately short:
 * anything that has not come up within ~1.5s has missed the window anyway.
 */
const INGRESS_RETRY_DELAYS_MS = [250, 1000]

function readDirOrEmpty (dir: string): string[] {
    try {
        return fs.readdirSync(dir)
    } catch {
        return []
    }
}

/** kill(pid, 0) probes without signalling; EPERM still means someone is there */
function isPidAlive (pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as { code?: string }).code === 'EPERM'
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
    private panes = new Map<string, TerminalTabComponent>()
    private armed = new WeakSet<TerminalTabComponent>()
    private watchedSplits = new WeakSet<SplitTabComponent>()
    /** Created on first use by ensureInjectDir(), never at construction */
    private injectDir: string | null = null
    private scraper: any = null
    /** Consecutive spinner-less polls per session — see scrapeOnce() */
    private spinnerMisses = new Map<string, number>()
    /** `snapshot.since` for turns whose spinner has actually been observed. */
    private spinnerObservedForTurn = new Map<string, number>()
    private shimInstallations = new WeakMap<TerminalTabComponent, TerminalCliShimInstallation>()

    constructor (
        private app: AppService,
        private ingress: HookIngressService,
        private bus: AiEventBusService,
        private zone: NgZone,
        private scanner: CliScannerService,
        private terminalShim: TerminalCliShimService,
        private directory: AiSessionDirectoryService,
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
        if (!(pane instanceof TerminalTabComponent)) {
            return null
        }
        return this.directory.forPane(pane, kind)?.sessionId ?? null
    }

    /** Reverse lookup for notification click-through */
    paneForSessionId (sessionId: string): TerminalTabComponent | null {
        return this.directory.forSession(sessionId)?.pane ?? null
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
        const { isDirectLaunch, kind } = this.launchIdentity(tab)
        // Adapter ownership is explicit: future full-tier CLIs get their own
        // event translator while reusing TerminalCliShimService.
        if (kind !== 'claude-code') {
            return
        }
        // During renderer recovery the tab exists before its PTY session is
        // reattached. Recovery markers are therefore the primary signal: if
        // we wait for tab.session, this method can mistake the recovering tab
        // for a fresh launch and replace the route used by the live process.
        if (this.claimExistingRun(tab, kind)) {
            return
        }
        const detected = isDirectLaunch
            ? null
            : this.scanner.scanResults.find(item =>
                item.entry.id === kind && item.target.type === 'native',
            ) ?? null
        if (!isDirectLaunch && !detected) {
            return
        }
        this.armed.add(tab)

        // Retrying here, not on a later sweep: injection is only possible
        // before the PTY spawns, and a sweep that arrives after spawn would
        // bounce off the tab.session check below — a lottery, not a retry.
        // When the budget runs out the session degrades to process detection,
        // and the tab stays armed so the sweeps stop re-attempting it.
        if (!await this.startIngressWithRetry()) {
            return
        }
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
        const dropDir = path.join(injectDir, DROP_DIR_NAME)
        try {
            fs.mkdirSync(dropDir, { recursive: true })
        } catch (error) {
            console.warn('[tabby-ai] could not create Claude hook drop directory', error)
            return
        }
        let settingsArgument = settingsPath
        let shim: TerminalCliShimInstallation|null = null
        let fileDropRegistered = false

        const targetId = tab.profile.options['aiCli']?.targetId
        const wslTarget = isDirectLaunch
            ? this.scanner.runtimeTargets.find(target => target.id === targetId && target.type === 'wsl')
            : null
        if (wslTarget?.type === 'wsl') {
            const curlPath = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'curl.exe')

            const mountRoot = wslTarget.windowsMountRoot
            const bridge = mountRoot
                // Scan-time metadata makes this branch fully synchronous — the
                // PTY spawns on frontend-ready, and any wsl.exe round-trip
                // here reliably loses that race and leaves the session
                // launched without our --settings.
                ? {
                    settings: translateWindowsPathWithMountRoot(mountRoot, settingsPath),
                    curl: translateWindowsPathWithMountRoot(mountRoot, curlPath),
                    drop: translateWindowsPathWithMountRoot(mountRoot, dropDir),
                    interop: wslTarget.windowsInterop === true,
                }
                // No scan metadata (excluded or stopped distro) — fall back to
                // asking the distro, one parallel round-trip.
                : await this.probeWslBridge(wslTarget, tab, settingsPath, curlPath, dropDir)
            if (!bridge) {
                // The spawn won the race during the probe round-trip: the
                // session is already running without our --settings. Injecting
                // now would only pretend — leave the tab unmonitored honestly.
                try {
                    fs.unlinkSync(settingsPath)
                } catch { /* already gone */ }
                console.warn('[tabby-ai] session spawned during WSL hook bridge setup; full support skipped')
                return
            }
            const translatedSettings = bridge.settings
            const translatedCurl = bridge.curl
            const translatedDrop = bridge.drop
            const interopWorks = bridge.interop && fs.existsSync(curlPath)
            if (!translatedSettings) {
                try {
                    fs.unlinkSync(settingsPath)
                } catch { /* already gone */ }
                console.warn(`[tabby-ai] WSL hook bridge unavailable in ${wslTarget.distro}; Claude will launch without full monitoring`)
                return
            }
            settingsArgument = translatedSettings
            const transport = selectWslHookTransport({
                dropAvailable: !!translatedDrop,
                curlAvailable: !!translatedCurl,
                interop: interopWorks,
            })
            if (transport === 'file') {
                fs.writeFileSync(
                    settingsPath,
                    JSON.stringify(this.settingsWithCommand(wslDropHookCommand(translatedDrop!, sessionId)), null, 2),
                    { mode: 0o600 },
                )
                this.ingress.registerFileDrop(sessionId, dropDir)
                fileDropRegistered = true
            } else if (transport === 'curl') {
                fs.writeFileSync(
                    settingsPath,
                    JSON.stringify(this.settingsFor(sessionId, quoteSh(translatedCurl!)), null, 2),
                    { mode: 0o600 },
                )
            } else {
                try {
                    fs.unlinkSync(settingsPath)
                } catch { /* already gone */ }
                console.warn(`[tabby-ai] WSL hook bridge unavailable in ${wslTarget.distro}; Claude will launch without full monitoring`)
                return
            }
        } else {
            const command = process.platform === 'win32'
                ? windowsDropHookCommand(dropDir, sessionId)
                : wslDropHookCommand(dropDir, sessionId)
            try {
                fs.writeFileSync(
                    settingsPath,
                    JSON.stringify(this.settingsWithCommand(command), null, 2),
                    { mode: 0o600 },
                )
            } catch (error) {
                console.warn('[tabby-ai] could not write native Claude file-drop hook', error)
                return
            }
            this.ingress.registerFileDrop(sessionId, dropDir)
            fileDropRegistered = true
        }

        const installedShim = this.installLaunchSettings({
            tab, isDirectLaunch, detected, injectDir, settingsPath, settingsArgument, sessionId,
        })
        if (installedShim === false) {
            return
        }
        shim = installedShim

        // empty string beats any inherited value in mergeEnv and reads as unset
        const persistedEnv = Object.fromEntries(
            Object.entries(tab.profile.options.env).filter(([key]) =>
                key !== CLAUDE_HOOK_SESSION_ENV && key !== CLAUDE_HOOK_TEMP_ENV,
            ),
        )
        const recoveryEnv: Record<string, string> = fileDropRegistered ? {
            [CLAUDE_HOOK_SESSION_ENV]: sessionId,
            [CLAUDE_HOOK_TEMP_ENV]: path.basename(injectDir),
        } : {}
        tab.profile.options.env = {
            ...persistedEnv,
            ...claudeEnvironmentOverrides(),
            ...recoveryEnv,
        }
        this.markRecoveryStateChanged(tab)

        this.registerRun(tab, sessionId, kind, settingsPath, shim)
    }

    private claimExistingRun (tab: TerminalTabComponent, kind: string): boolean {
        if (this.restoreRun(tab, kind)) {
            this.armed.add(tab)
            return true
        }
        if (!tab.session) {
            return false
        }
        this.armed.add(tab)
        console.warn('[tabby-ai] live Claude session has no recoverable hook route; full listening skipped')
        return true
    }

    private launchIdentity (tab: TerminalTabComponent): { isDirectLaunch: boolean, kind: string|undefined } {
        const isDirectLaunch = tab.profile.type === 'ai-cli'
        return {
            isDirectLaunch,
            kind: isDirectLaunch ? tab.profile.options['aiCli']?.kind : 'claude-code',
        }
    }

    private installLaunchSettings (input: {
        tab: TerminalTabComponent
        isDirectLaunch: boolean
        detected: DetectedCli|null
        injectDir: string
        settingsPath: string
        settingsArgument: string
        sessionId: string
    }): TerminalCliShimInstallation|null|false {
        const { tab, isDirectLaunch, detected, injectDir, settingsPath, settingsArgument, sessionId } = input
        if (isDirectLaunch) {
            const args = tab.profile.options.args.slice()
            for (let i = args.length - 2; i >= 0; i--) {
                if (args[i] === '--settings' && String(args[i + 1]).includes(HOOK_DIR_PREFIX)) {
                    args.splice(i, 2)
                }
            }
            args.push('--settings', settingsArgument)
            tab.profile.options.args = args
            return null
        }

        const shimDirectory = path.join(injectDir, `${SHIM_DIR_PREFIX}${process.pid}-${sessionId}`)
        try {
            const shim = this.terminalShim.install(
                tab,
                detected!,
                shimDirectory,
                ['--settings', settingsPath],
            )
            this.shimInstallations.set(tab, shim)
            return shim
        } catch (error) {
            try {
                fs.unlinkSync(settingsPath)
            } catch { /* already gone */ }
            this.ingress.unregisterFileDrop(sessionId)
            console.error('[tabby-ai] could not install terminal CLI shim, session will use process detection', error)
            return false
        }
    }

    private restoreRun (tab: TerminalTabComponent, kind: string): boolean {
        const recovery = claudeHookRecovery(tab.profile.options.env)
        if (!recovery) {
            return false
        }
        const injectDir = path.join(os.tmpdir(), recovery.tempName)
        const resolved = path.resolve(injectDir)
        const dropDir = path.join(resolved, DROP_DIR_NAME)
        if (
            path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
            !isHookDirName(path.basename(resolved)) ||
            !fs.existsSync(dropDir)
        ) {
            return false
        }
        const settingsName = readDirOrEmpty(resolved).find(name =>
            name.endsWith(`-${recovery.sessionId}.json`),
        )
        if (!settingsName) {
            return false
        }
        this.ingress.registerFileDrop(recovery.sessionId, dropDir)
        this.registerRun(
            tab,
            recovery.sessionId,
            kind,
            path.join(resolved, settingsName),
            null,
        )
        console.info(`[tabby-ai] restored Claude hook route [${recovery.sessionId.slice(0, 8)}]`)
        return true
    }

    private registerRun (
        tab: TerminalTabComponent,
        sessionId: string,
        kind: string,
        settingsPath: string,
        shim: TerminalCliShimInstallation|null,
    ): void {
        this.directory.bind({ sessionId, kind, pane: tab })
        this.panes.set(sessionId, tab)
        this.startScraper()

        let currentSession: BaseSession|null = tab.session
        const attachSession = (session: BaseSession|null): void => {
            if (!session) {
                return
            }
            session.destroyed$.subscribe(() => {
                console.debug(`[tabby-ai] adapter [${sessionId.slice(0, 8)}] session destroyed`)
                this.onSessionDown(sessionId)
            })
        }
        attachSession(currentSession)
        tab.sessionChanged$.subscribe(session => {
            if (session === currentSession) {
                return
            }
            currentSession = session
            console.debug(`[tabby-ai] adapter [${sessionId.slice(0, 8)}] sessionChanged: ${session ? 'live' : 'null'}`)
            attachSession(session)
        })
        tab.destroyed$.subscribe(() => {
            try {
                fs.unlinkSync(settingsPath)
            } catch { /* already gone */ }
            // unregister also drops the stateful projector. It is safe for the
            // rare curl fallback, where no file registration exists.
            this.ingress.unregisterFileDrop(sessionId)
            shim?.remove()
            this.shimInstallations.delete(tab)
            this.panes.delete(sessionId)
            this.directory.unbind(sessionId)
            this.spinnerMisses.delete(sessionId)
            this.spinnerObservedForTurn.delete(sessionId)
            this.stopScraperIfIdle()
            this.zone.run(() => this.bus.dropSession(sessionId))
        })
    }

    private markRecoveryStateChanged (tab: TerminalTabComponent): void {
        const recoveryTab = tab as unknown as {
            recoveryStateChangedHint: { next: () => void }
        }
        recoveryTab.recoveryStateChangedHint.next()
    }

    /**
     * The launch-time WSL bridge data when the scanner has none cached for
     * this distro. The curl.exe lane needs more than the mount: executing a
     * Windows binary rides the distro's binfmt interop handler, which systemd
     * distros routinely lose — so the probe runs the real thing.
     *
     * Null when the PTY spawned during the round-trip and injection is
     * already too late.
     */
    private async probeWslBridge (
        wslTarget: WslCliRuntimeTarget,
        tab: TerminalTabComponent,
        settingsPath: string,
        curlPath: string,
        dropDir: string,
    ): Promise<{ settings: string|null, curl: string|null, drop: string|null, interop: boolean }|null> {
        const [settings, curl, drop, interop] = await Promise.all([
            translateWindowsPathForWsl(wslTarget, settingsPath),
            translateWindowsPathForWsl(wslTarget, curlPath),
            translateWindowsPathForWsl(wslTarget, dropDir),
            fs.existsSync(curlPath)
                ? windowsExecutableRunsInWsl(wslTarget, curlPath)
                : Promise.resolve(false),
        ])
        if (tab.session) {
            return null
        }
        return { settings, curl, drop, interop }
    }

    /** True once the ingress is listening; false when every attempt failed */
    private async startIngressWithRetry (): Promise<boolean> {
        for (let attempt = 0; ; attempt++) {
            try {
                await this.ingress.start()
                return true
            } catch (error) {
                if (attempt >= INGRESS_RETRY_DELAYS_MS.length) {
                    console.error('[tabby-ai] hook ingress unavailable, session will use process detection', error)
                    return false
                }
                await new Promise(resolve => setTimeout(resolve, INGRESS_RETRY_DELAYS_MS[attempt]))
            }
        }
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
            const snapshot = this.bus.snapshotFor(sessionId)
            if (snapshot?.state !== 'working') {
                this.spinnerMisses.delete(sessionId)
                this.spinnerObservedForTurn.delete(sessionId)
                continue
            }

            const status = this.readStatusLine(pane)
            if (status) {
                this.spinnerMisses.delete(sessionId)
                this.spinnerObservedForTurn.set(sessionId, snapshot.since)
                // compared against the bus, not a private cache: reduceSnapshot
                // clears liveStatus at the end of a turn, so a cache would
                // suppress an identical caption for the whole next turn
                if (status !== snapshot.liveStatus) {
                    this.zone.run(() => this.bus.setLiveStatus(sessionId, status))
                }
                continue
            }

            // No spinner while we still believe it is working. A terminating
            // hook that never made it leaves exactly this, and the absence is
            // the only thing that will ever say otherwise.
            const misses = (this.spinnerMisses.get(sessionId) ?? 0) + 1
            this.spinnerMisses.set(sessionId, misses)
            const quietFor = Date.now() - (snapshot.lastEvent?.ts ?? snapshot.since)
            const observedThisTurn = this.spinnerObservedForTurn.get(sessionId) === snapshot.since
            // A structured PreToolUse without its matching result means the
            // tool is still authoritative. Status rows can disappear while a
            // long Bash/WebSearch/agent call owns the screen; absence is not
            // evidence that the turn ended.
            if (this.ingress.claudeHasActiveTools(sessionId)) {
                continue
            }
            if (!spinnerAbsenceEndsTurn(misses, quietFor, observedThisTurn)) {
                continue
            }
            this.spinnerMisses.delete(sessionId)
            this.spinnerObservedForTurn.delete(sessionId)
            console.debug(`[tabby-ai] adapter [${sessionId.slice(0, 8)}] spinner gone for ${misses} polls, quiet ${quietFor}ms → turn over`)
            this.zone.run(() => this.bus.publish({
                sessionId,
                ts: Date.now(),
                kind: 'turn-completed',
                // inferred from the screen, not reported by claude
                confidence: 'low',
                summary: 'idle',
            }))
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

    private settingsFor (sessionId: string, curlCommand = 'curl'): unknown {
        // values are baked in as literals — never rely on shell variable expansion (§2)
        return this.settingsWithCommand(`${curlCommand} -s -m 3 --data-binary @- "${this.ingress.endpointFor(sessionId)}"`)
    }

    private settingsWithCommand (command: string): unknown {
        const hooks: Record<string, unknown> = {}
        for (const event of CLAUDE_HOOK_EVENTS) {
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
            if (!isHookDirName(name) && !isLegacyHookDirName(name)) {
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
                // is a recursive delete — let the contents confirm it. A live
                // owner pid means another vibby instance is still using the
                // directory, however old its mtime is.
                const entries = fs.readdirSync(dir)
                if (holdsOnlyGeneratedFiles(entries) && !ownerPids(entries).some(isPidAlive)) {
                    fs.rmSync(dir, { recursive: true, force: true })
                }
            } catch { /* raced another instance's cleanup */ }
        }
    }
}
