import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import type { DetectedCli, WslCliRuntimeTarget } from '../api'
import {
    GROK_DROP_DIR_NAME,
    GROK_HOOK_CONFIG_NAME,
    GROK_HOOK_DIR_NAME,
    GROK_HOOK_DROP_ENV,
    GROK_HOOK_ENDPOINT_ENV,
    GROK_HOOK_SCRIPT_CMD_NAME,
    GROK_HOOK_SCRIPT_NAME,
    GROK_HOOK_SCRIPT_PS1_NAME,
    GROK_HOOK_SESSION_ENV,
    GROK_TEMP_DIR_PREFIX,
    buildGrokHookConfig,
    buildGrokHookScript,
    buildGrokHookScriptCmd,
    buildGrokHookScriptPs1,
    grokHookEnvironment,
    grokHookRecovery,
    withoutStaleGrokHookEnv,
} from '../grokHooks'
import { SHIM_DIR_PREFIX } from '../paths'
import {
    translateWindowsPathForWsl,
    translateWindowsPathWithMountRoot,
    wslExecutablePath,
} from '../runtimeTargets'
import { AiEventBusService } from './eventBus.service'
import { CliScannerService } from './cliScanner.service'
import { HookIngressService } from './hookIngress.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { TerminalCliShimInstallation, TerminalCliShimService } from './terminalCliShim.service'

const KIND = 'grok-build'
const EXIT_GRACE_MS = 500

/** Substituted with the in-distro absolute script path by the WSL installer. */
const SCRIPT_PLACEHOLDER = '@VIBBY_GROK_SCRIPT@'

/**
 * Subcommands that never open a session. Wrapping them would put the shim
 * between the user and an interactive browser login or an updater.
 */
const PASSTHROUGH_SUBCOMMANDS = [
    'login',
    'logout',
    'doctor',
    'update',
    'models',
    'mcp',
    'plugin',
    'sessions',
    'memory',
    'worktree',
    'completions',
    'export',
    'trace',
    'setup',
    'leader',
    'inspect',
    'version',
    'wrap',
    'help',
    '--version',
    '-V',
]

interface GrokRun {
    tab: TerminalTabComponent
    sessionId: string
    direct: boolean
    shim: TerminalCliShimInstallation|null
    tempRoot: string|null
    disposed: boolean
}

function sessionAppeared (tab: TerminalTabComponent): boolean {
    return !!tab.session
}

/** Distro encoded in a direct `wsl.exe` grok launch (same shape as Pi/Kimi). */
function grokWslDistroFromArgs (args: string[]): string|null {
    if (
        args.length >= 6 &&
        args[0] === '--distribution' &&
        args[4] === '--exec'
    ) {
        return args[1].trim() || null
    }
    return null
}

function nativeGrokHome (): string {
    const configured = process.env.GROK_HOME?.trim()
    if (configured) {
        return configured
    }
    return path.join(os.homedir(), '.grok')
}

function runWsl (distro: string, args: string[], timeout = 8000): Promise<string|null> {
    return new Promise(resolve => {
        execFile(
            wslExecutablePath(),
            ['--distribution', distro, ...args],
            {
                timeout,
                windowsHide: true,
                env: { ...process.env, WSL_UTF8: '1' },
                encoding: 'utf8',
            },
            (error, stdout, stderr) => {
                if (error) {
                    console.warn(
                        `[tabby-ai] WSL helper failed distro=${distro} status=${(error as { status?: number }).status ?? '?'} stderr=${stderr.slice(0, 300)}`,
                    )
                    resolve(null)
                    return
                }
                resolve(stdout)
            },
        )
    })
}

/**
 * Keeps the permanent bridge idempotent: rewrite only when the bytes differ.
 * The mode is applied separately because `writeFileSync` only honours it while
 * creating the file, and a bridge left without +x would silently stop firing.
 */
function writeIfChanged (target: string, content: string, mode?: number): void {
    let changed = true
    try {
        changed = fs.readFileSync(target, 'utf8') !== content
    } catch { /* missing or unreadable — fall through to the write */ }
    if (changed) {
        fs.writeFileSync(target, content)
    }
    if (mode !== undefined) {
        try {
            fs.chmodSync(target, mode)
        } catch { /* filesystem without POSIX modes */ }
    }
}

/**
 * Grok monitoring installs one permanent hook bridge into the user's own grok
 * home (`~/.grok/hooks/`, always trusted, no folder-trust needed) and scopes it
 * per session with environment variables injected at launch. Sessions Vibby did
 * not launch leave those unset and the bridge exits before reading stdin.
 *
 * This is deliberately unlike the other adapters, which shadow the CLI's home
 * directory: grok's home holds the credential file it rewrites on token
 * refresh, the managed install, and the plugin cache, and it refuses to start
 * under a symlinked `$GROK_HOME` in sandbox profiles. Bridging instead of
 * shadowing also empties the arming hot path — no config generation, no
 * symlinks, no wsl.exe round-trip between arming and the PTY spawn.
 */
@Injectable({ providedIn: 'root' })
export class GrokAdapterService {
    private armed = new WeakSet<TerminalTabComponent>()
    private arming = new WeakSet<TerminalTabComponent>()
    private watchedSplits = new WeakSet<SplitTabComponent>()
    private runs = new WeakMap<TerminalTabComponent, GrokRun>()
    /** Target id → in-flight or settled bridge install, one attempt per session */
    private bridges = new Map<string, Promise<boolean>>()

    constructor (
        private app: AppService,
        private scanner: CliScannerService,
        private ingress: HookIngressService,
        private terminalShim: TerminalCliShimService,
        private directory: AiSessionDirectoryService,
        private bus: AiEventBusService,
        private zone: NgZone,
    ) { }

    activate (): void {
        this.ingress.start().catch(() => null)
        this.app.tabOpened$.subscribe(tab => this.visit(tab))
        this.app.tabsChanged$.subscribe(() => this.app.tabs.forEach(tab => this.visit(tab)))
        this.scanner.scanResults$.subscribe(() => {
            this.installBridges()
            this.app.tabs.forEach(tab => this.visit(tab))
        })
        this.installBridges()
        this.app.tabs.forEach(tab => this.visit(tab))
    }

    /**
     * Install the permanent bridge for every runtime where grok was detected.
     * Done at scan time rather than at arm time: the WSL lane needs a wsl.exe
     * round-trip, and anything between arming and the PTY spawn loses the race.
     */
    private installBridges (): void {
        for (const item of this.scanner.scanResults) {
            if (item.entry.id !== KIND) {
                continue
            }
            void this.ensureBridge(item.target)
        }
    }

    private ensureBridge (target: DetectedCli['target']): Promise<boolean> {
        const existing = this.bridges.get(target.id)
        if (existing) {
            return existing
        }
        const install = (target.type === 'wsl'
            ? this.installWslBridge(target)
            : Promise.resolve(this.installNativeBridge())
        ).then(ok => {
            // A distro that was not running yet, or a home that did not exist,
            // must not be written off for the rest of the session.
            if (!ok) {
                this.bridges.delete(target.id)
            }
            return ok
        })
        this.bridges.set(target.id, install)
        return install
    }

    private installNativeBridge (): boolean {
        const hooksDir = path.join(nativeGrokHome(), GROK_HOOK_DIR_NAME)
        const scriptName = process.platform === 'win32'
            ? GROK_HOOK_SCRIPT_CMD_NAME
            : GROK_HOOK_SCRIPT_NAME
        const scriptPath = path.join(hooksDir, scriptName)
        try {
            fs.mkdirSync(hooksDir, { recursive: true })
            if (process.platform === 'win32') {
                writeIfChanged(scriptPath, buildGrokHookScriptCmd())
                writeIfChanged(path.join(hooksDir, GROK_HOOK_SCRIPT_PS1_NAME), buildGrokHookScriptPs1())
            } else {
                writeIfChanged(scriptPath, buildGrokHookScript(), 0o700)
            }
            writeIfChanged(path.join(hooksDir, GROK_HOOK_CONFIG_NAME), buildGrokHookConfig(scriptPath))
            return true
        } catch (error) {
            console.warn('[tabby-ai] could not install the Grok hook bridge', error)
            return false
        }
    }

    /**
     * The distro's own `~/.grok/hooks/`. Contents travel base64-encoded because
     * Windows execFile is unreliable with embedded newlines, and the absolute
     * script path is substituted inside the distro where `$HOME` is known.
     */
    private async installWslBridge (target: WslCliRuntimeTarget): Promise<boolean> {
        const script = Buffer.from(buildGrokHookScript(), 'utf8').toString('base64')
        const config = Buffer.from(buildGrokHookConfig(SCRIPT_PLACEHOLDER), 'utf8').toString('base64')
        const shell = [
            `H="$HOME/.grok/${GROK_HOOK_DIR_NAME}"`,
            'mkdir -p "$H" || exit 1',
            `printf %s '${script}' | base64 -d > "$H/${GROK_HOOK_SCRIPT_NAME}" || exit 1`,
            `chmod 700 "$H/${GROK_HOOK_SCRIPT_NAME}" || exit 1`,
            `printf %s '${config}' | base64 -d | sed "s|${SCRIPT_PLACEHOLDER}|$H/${GROK_HOOK_SCRIPT_NAME}|" > "$H/${GROK_HOOK_CONFIG_NAME}" || exit 1`,
        ].join('; ')
        const result = await runWsl(target.distro, ['--exec', '/bin/sh', '-c', shell])
        if (result === null) {
            console.warn(`[tabby-ai] could not install the Grok hook bridge in ${target.distro}`)
            return false
        }
        return true
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
        if (this.armed.has(tab) || this.arming.has(tab)) {
            return
        }
        const direct = tab.profile.type === 'ai-cli'
        const kind = direct ? tab.profile.options['aiCli']?.kind : KIND
        if (kind !== KIND) {
            return
        }
        if (
            direct &&
            tab.profile.options.restoreFromPTYID &&
            this.restoreRun(tab)
        ) {
            return
        }
        if (direct) {
            tab.profile.options.env = withoutStaleGrokHookEnv({ ...tab.profile.options.env })
        }
        const detected = direct ? null : this.scanner.scanResults.find(item =>
            item.entry.id === KIND &&
            item.target.type === 'native' &&
            item.monitoring === 'full',
        ) ?? null
        if (!direct && !detected) {
            return
        }
        if (tab.session) {
            return
        }
        this.arming.add(tab)
        try {
            await this.configure(tab, direct, detected)
        } finally {
            this.arming.delete(tab)
        }
    }

    private async configure (
        tab: TerminalTabComponent,
        direct: boolean,
        detected: DetectedCli|null,
    ): Promise<void> {
        const sessionId = crypto.randomUUID()
        const originalEnv = withoutStaleGrokHookEnv({ ...tab.profile.options.env })
        const originalArgs = [...tab.profile.options.args]
        if (direct) {
            tab.profile.options.env = originalEnv
        }

        const aiCli = tab.profile.options['aiCli']
        const targetId = aiCli?.targetId
        const storedMountRoot = aiCli?.windowsMountRoot
        const wrappedWslDistro = grokWslDistroFromArgs(originalArgs)
        try {
            const known = this.scanner.scanResults.find(item =>
                item.entry.id === KIND && item.target.id === targetId,
            )
            const knownMount = known?.target.type === 'wsl' ? known.target.windowsMountRoot : null
            await Promise.all([
                this.ingress.start(),
                (targetId?.startsWith('wsl:') || wrappedWslDistro) && !(storedMountRoot || knownMount)
                    ? this.scanner.ensureScanned()
                    : Promise.resolve(),
            ])
            if (aiCli && !aiCli.windowsMountRoot && knownMount) {
                aiCli.windowsMountRoot = knownMount
            }
        } catch (error) {
            console.warn('[tabby-ai] Grok hook prerequisites unavailable', error)
            return
        }
        if (sessionAppeared(tab)) {
            console.warn('[tabby-ai] Grok session spawned before hook injection; full support skipped')
            return
        }

        const wslTarget = direct
            ? this.scanner.runtimeTargets.find(target =>
                target.type === 'wsl' &&
                (
                    wrappedWslDistro
                        ? target.distro.toLocaleLowerCase() === wrappedWslDistro.toLocaleLowerCase()
                        : target.id === targetId
                ),
            )
            : null
        const wantsWsl = Boolean(wslTarget ?? wrappedWslDistro ?? targetId?.startsWith('wsl:'))
        if (wantsWsl && !wslTarget) {
            console.warn(`[tabby-ai] WSL target metadata unavailable for Grok (${wrappedWslDistro ?? targetId}); full support skipped`)
            return
        }

        // The bridge is normally already in place from scan time; awaiting here
        // only costs anything on the very first launch after startup, and a
        // missing bridge means the hooks would never fire at all.
        const bridged = await this.ensureBridge(
            wslTarget ?? detected?.target ?? { id: 'native', type: 'native' } as DetectedCli['target'],
        )
        if (!bridged) {
            console.warn('[tabby-ai] Grok hook bridge unavailable; launching without full monitoring')
            return
        }
        if (sessionAppeared(tab)) {
            console.warn('[tabby-ai] Grok session spawned during hook bridge setup; full support skipped')
            return
        }

        let tempRoot: string|null = null
        try {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), GROK_TEMP_DIR_PREFIX))
        } catch (error) {
            console.warn('[tabby-ai] could not create the Grok hook temp directory', error)
            return
        }
        const dropDir = path.join(tempRoot, GROK_DROP_DIR_NAME)
        try {
            fs.mkdirSync(dropDir, { recursive: true })
        } catch (error) {
            this.removeTempRoot(tempRoot)
            console.warn('[tabby-ai] could not create the Grok hook drop directory', error)
            return
        }

        let transport: { dropDir?: string|null, endpoint?: string|null } = { dropDir }
        let fileDropRegistered = false

        if (wslTarget?.type === 'wsl') {
            const prepared = await this.prepareWslTransport(tab, wslTarget, dropDir, sessionId)
            if (!prepared) {
                this.removeTempRoot(tempRoot)
                return
            }
            transport = prepared.transport
            fileDropRegistered = prepared.fileDropRegistered
            if (aiCli && !aiCli.windowsMountRoot) {
                aiCli.windowsMountRoot = wslTarget.windowsMountRoot
            }
        } else {
            this.ingress.registerFileDrop(sessionId, dropDir, 'grok')
            fileDropRegistered = true
        }

        if (sessionAppeared(tab)) {
            this.removeTempRoot(tempRoot)
            if (fileDropRegistered) {
                this.ingress.unregisterFileDrop(sessionId)
            }
            console.warn('[tabby-ai] Grok session spawned during hook injection; full support skipped')
            return
        }

        const injectedEnv = grokHookEnvironment(
            sessionId,
            transport,
            originalEnv,
            { wsl: wslTarget?.type === 'wsl' },
        )

        let shim: TerminalCliShimInstallation|null = null
        if (direct) {
            tab.profile.options.env = injectedEnv
        } else {
            try {
                const shimDirectory = path.join(tempRoot, `${SHIM_DIR_PREFIX}${process.pid}-${sessionId}`)
                const shimEnv: Record<string, string> = { [GROK_HOOK_SESSION_ENV]: sessionId }
                if (transport.dropDir) {
                    shimEnv[GROK_HOOK_DROP_ENV] = transport.dropDir
                } else if (transport.endpoint) {
                    shimEnv[GROK_HOOK_ENDPOINT_ENV] = transport.endpoint
                }
                shim = this.terminalShim.install(
                    tab,
                    detected!,
                    shimDirectory,
                    [],
                    shimEnv,
                    PASSTHROUGH_SUBCOMMANDS,
                )
            } catch (error) {
                this.removeTempRoot(tempRoot)
                this.ingress.unregisterFileDrop(sessionId)
                console.warn('[tabby-ai] could not install Grok hook shim', error)
                return
            }
        }

        this.registerRun({
            tab,
            sessionId,
            direct,
            shim,
            tempRoot,
            disposed: false,
        }, true)
    }

    /**
     * Pick the lane the distro can actually reach. The drop directory is a
     * Windows path, so it needs translating through the C-drive mount; when
     * that is unavailable the bridge falls back to POSTing at the loopback
     * ingress with the distro's own curl.
     */
    private async prepareWslTransport (
        tab: TerminalTabComponent,
        wslTarget: WslCliRuntimeTarget,
        dropDir: string,
        sessionId: string,
    ): Promise<{ transport: { dropDir?: string|null, endpoint?: string|null }, fileDropRegistered: boolean }|null> {
        const mountRoot = wslTarget.windowsMountRoot
            ?? tab.profile.options['aiCli']?.windowsMountRoot
            ?? null
        const translatedDrop = mountRoot
            ? translateWindowsPathWithMountRoot(mountRoot, dropDir)
            : await translateWindowsPathForWsl(wslTarget, dropDir)
        if (sessionAppeared(tab)) {
            console.warn('[tabby-ai] Grok session spawned during WSL path setup; full support skipped')
            return null
        }
        if (translatedDrop) {
            this.ingress.registerFileDrop(sessionId, dropDir, 'grok')
            return { transport: { dropDir: translatedDrop }, fileDropRegistered: true }
        }
        // Unlike the other adapters this fallback runs the distro's own curl,
        // not Windows curl.exe over interop: the bridge script is a POSIX
        // script executing inside the distro, so it never crosses back.
        try {
            return {
                transport: { endpoint: this.ingress.grokEndpointFor(sessionId) },
                fileDropRegistered: false,
            }
        } catch (error) {
            console.warn(`[tabby-ai] hook ingress unavailable for ${wslTarget.distro}; Grok will launch without full monitoring`, error)
            return null
        }
    }

    private restoreRun (tab: TerminalTabComponent): boolean {
        const recovery = grokHookRecovery(tab.profile.options.env)
        if (!recovery) {
            return false
        }
        const env = tab.profile.options.env
        const dropDir = Object.prototype.hasOwnProperty.call(env, GROK_HOOK_DROP_ENV)
            ? env[GROK_HOOK_DROP_ENV]
            : ''
        // Only the drop lane survives a reload: the endpoint carries the port
        // of an ingress that no longer exists. Windows paths are what the
        // poller reads, so a translated WSL path cannot be restored from here.
        const tempRoot = dropDir ? path.dirname(dropDir) : ''
        if (
            !tempRoot ||
            path.dirname(path.resolve(tempRoot)) !== path.resolve(os.tmpdir()) ||
            !path.basename(tempRoot).startsWith(GROK_TEMP_DIR_PREFIX) ||
            path.basename(dropDir) !== GROK_DROP_DIR_NAME ||
            !fs.existsSync(dropDir)
        ) {
            return false
        }
        this.ingress.registerFileDrop(recovery.sessionId, dropDir, 'grok')
        this.registerRun({
            tab,
            sessionId: recovery.sessionId,
            direct: true,
            shim: null,
            tempRoot,
            disposed: false,
        }, true)
        console.info(`[tabby-ai] restored Grok hook route [${recovery.sessionId.slice(0, 8)}]`)
        return true
    }

    private registerRun (run: GrokRun, publishReady: boolean): void {
        this.runs.set(run.tab, run)
        this.armed.add(run.tab)
        this.directory.bind({ sessionId: run.sessionId, kind: KIND, pane: run.tab })

        if (publishReady) {
            this.zone.run(() => this.bus.publish({
                sessionId: run.sessionId,
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
        run.tab.sessionChanged$.subscribe(attachSession)
        attachSession(run.tab.session)
        run.tab.destroyed$.subscribe(() => this.dispose(run))
    }

    private onSessionDown (run: GrokRun): void {
        setTimeout(() => {
            const snapshot = this.bus.snapshotFor(run.sessionId)
            if (snapshot && snapshot.lastEvent?.kind !== 'session-ended') {
                this.zone.run(() => this.bus.publish({
                    sessionId: run.sessionId,
                    ts: Date.now(),
                    kind: 'process-exited',
                    confidence: 'high',
                    summary: 'Grok exited',
                }))
            }
        }, EXIT_GRACE_MS)
    }

    private dispose (run: GrokRun): void {
        if (run.disposed) {
            return
        }
        run.disposed = true
        run.shim?.remove()
        if (run.tempRoot) {
            this.removeTempRoot(run.tempRoot)
        }
        this.ingress.unregisterFileDrop(run.sessionId)
        this.directory.unbind(run.sessionId)
        this.zone.run(() => this.bus.dropSession(run.sessionId))
        // The bridge in the user's grok home is permanent and shared by every
        // session, so teardown never touches it.
    }

    private removeTempRoot (directory: string): void {
        const resolved = path.resolve(directory)
        if (
            path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
            !path.basename(resolved).startsWith(GROK_TEMP_DIR_PREFIX)
        ) {
            console.warn('[tabby-ai] refusing to remove unexpected Grok temp directory')
            return
        }
        try {
            fs.rmSync(resolved, { recursive: true, force: true })
        } catch { /* already gone */ }
    }
}
