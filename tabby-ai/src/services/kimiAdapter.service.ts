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
    KIMI_CODE_HOME_ENV,
    KIMI_DROP_DIR_NAME,
    KIMI_HOOK_SESSION_ENV,
    KIMI_HOOK_TEMP_ENV,
    KIMI_TEMP_DIR_PREFIX,
    buildKimiConfigToml,
    kimiCopiedFiles,
    kimiCurlHookCommand,
    kimiHookEnvironment,
    kimiHookRecovery,
    kimiLinkedDirs,
    withoutStaleKimiHookEnv,
} from '../kimiHooks'
import { SHIM_DIR_PREFIX, quoteSh } from '../paths'
import {
    translateWindowsPathForWsl,
    translateWindowsPathWithMountRoot,
    windowsExecutableRunsInWsl,
    wslExecutablePath,
} from '../runtimeTargets'
import { selectWslHookTransport, windowsDropHookCommand, wslDropHookCommand } from '../wslHookBridge'
import { AiEventBusService } from './eventBus.service'
import { CliScannerService } from './cliScanner.service'
import { HookIngressService } from './hookIngress.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { TerminalCliShimInstallation, TerminalCliShimService } from './terminalCliShim.service'

const KIND = 'kimi-code'
const EXIT_GRACE_MS = 500

const PASSTHROUGH_SUBCOMMANDS = [
    'login',
    'doctor',
    'acp',
    'web',
    'server',
    'upgrade',
    'update',
    'provider',
    'migrate',
    'export',
    'vis',
    'help',
    '--version',
    '-V',
]

interface KimiRun {
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

/** Distro encoded in a direct `wsl.exe` Kimi launch (same shape as Pi). */
function kimiWslDistroFromArgs (args: string[]): string|null {
    if (
        args.length >= 6 &&
        args[0] === '--distribution' &&
        args[4] === '--exec'
    ) {
        return args[1]?.trim() || null
    }
    return null
}

function realKimiHome (): string {
    const override = process.env.KIMI_CODE_HOME?.trim()
    if (override && !path.basename(override).startsWith(KIMI_TEMP_DIR_PREFIX)) {
        return override
    }
    return path.join(os.homedir(), '.kimi-code')
}

function readUserConfig (home: string): string {
    try {
        return fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
    } catch {
        return ''
    }
}

function linkNativeHome (tempRoot: string, realHome: string): void {
    for (const dir of kimiLinkedDirs()) {
        const source = path.join(realHome, dir)
        const target = path.join(tempRoot, dir)
        if (!fs.existsSync(source) || fs.existsSync(target)) {
            continue
        }
        try {
            fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
        } catch (error) {
            console.warn(`[tabby-ai] could not link Kimi ${dir}`, error)
        }
    }
    for (const file of kimiCopiedFiles()) {
        const source = path.join(realHome, file)
        const target = path.join(tempRoot, file)
        if (!fs.existsSync(source) || fs.existsSync(target)) {
            continue
        }
        try {
            fs.copyFileSync(source, target)
        } catch (error) {
            console.warn(`[tabby-ai] could not copy Kimi ${file}`, error)
        }
    }
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
 * Kimi monitoring injects a per-session `KIMI_CODE_HOME` with the user's
 * config plus Vibby [[hooks]], then forwards hook stdin JSON through the
 * shared HookIngressService (file-drop preferred, curl as WSL fallback).
 */
@Injectable({ providedIn: 'root' })
export class KimiAdapterService {
    private armed = new WeakSet<TerminalTabComponent>()
    private arming = new WeakSet<TerminalTabComponent>()
    private watchedSplits = new WeakSet<SplitTabComponent>()
    private runs = new WeakMap<TerminalTabComponent, KimiRun>()

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
            tab.profile.options.env = withoutStaleKimiHookEnv({ ...tab.profile.options.env })
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
        const originalEnv = withoutStaleKimiHookEnv({ ...tab.profile.options.env })
        const originalArgs = [...tab.profile.options.args]
        if (direct) {
            tab.profile.options.env = originalEnv
        }

        const aiCli = tab.profile.options['aiCli']
        const targetId = aiCli?.targetId
        const storedMountRoot = aiCli?.windowsMountRoot
        const wrappedWslDistro = kimiWslDistroFromArgs(originalArgs)
        try {
            // Prefer the already-scanned DetectedCli mount root so arming does
            // not wait on a full rescan when the dashboard already showed WSL.
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
            console.warn('[tabby-ai] Kimi hook prerequisites unavailable', error)
            return
        }
        if (sessionAppeared(tab)) {
            console.warn('[tabby-ai] Kimi session spawned before hook injection; full support skipped')
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
            console.warn(`[tabby-ai] WSL target metadata unavailable for Kimi (${wrappedWslDistro ?? targetId}); full support skipped`)
            return
        }

        let tempRoot: string|null = null
        try {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), KIMI_TEMP_DIR_PREFIX))
        } catch (error) {
            console.warn('[tabby-ai] could not create the Kimi hook temp directory', error)
            return
        }
        const dropDir = path.join(tempRoot, KIMI_DROP_DIR_NAME)
        try {
            fs.mkdirSync(dropDir, { recursive: true })
        } catch (error) {
            this.removeTempRoot(tempRoot)
            console.warn('[tabby-ai] could not create the Kimi hook drop directory', error)
            return
        }

        const tempName = path.basename(tempRoot)
        let hookHome = { command: '', home: '' }
        let fileDropRegistered = false
        let shim: TerminalCliShimInstallation|null = null

        if (wslTarget?.type === 'wsl') {
            const prepared = await this.prepareWslHome(tab, wslTarget, tempRoot, dropDir, sessionId)
            if (!prepared) {
                this.removeTempRoot(tempRoot)
                return
            }
            hookHome = { command: prepared.hookCommand, home: prepared.home }
            fileDropRegistered = prepared.fileDropRegistered
            if (aiCli && !aiCli.windowsMountRoot) {
                aiCli.windowsMountRoot = wslTarget.windowsMountRoot
            }
        } else {
            linkNativeHome(tempRoot, realKimiHome())
            hookHome = {
                command: process.platform === 'win32'
                    ? windowsDropHookCommand(dropDir, sessionId)
                    : wslDropHookCommand(dropDir, sessionId),
                home: tempRoot,
            }
            this.ingress.registerFileDrop(sessionId, dropDir, 'kimi')
            fileDropRegistered = true
        }

        try {
            // WSL user config is optional — a wsl.exe round-trip here loses the
            // PTY spawn race. Built-in defaults apply when the file is absent.
            const userConfig = wslTarget?.type === 'wsl'
                ? ''
                : readUserConfig(realKimiHome())
            fs.writeFileSync(
                path.join(tempRoot, 'config.toml'),
                buildKimiConfigToml(userConfig, hookHome.command),
                { mode: 0o600 },
            )
        } catch (error) {
            this.removeTempRoot(tempRoot)
            if (fileDropRegistered) {
                this.ingress.unregisterFileDrop(sessionId)
            }
            console.warn('[tabby-ai] could not write Kimi hook config', error)
            return
        }
        if (sessionAppeared(tab)) {
            this.removeTempRoot(tempRoot)
            if (fileDropRegistered) {
                this.ingress.unregisterFileDrop(sessionId)
            }
            console.warn('[tabby-ai] Kimi session spawned during hook injection; full support skipped')
            return
        }

        const injectedEnv = kimiHookEnvironment(
            hookHome.home,
            sessionId,
            tempName,
            originalEnv,
            { wsl: wslTarget?.type === 'wsl' },
        )

        if (direct) {
            tab.profile.options.env = injectedEnv
        } else {
            try {
                const shimDirectory = path.join(tempRoot, `${SHIM_DIR_PREFIX}${process.pid}-${sessionId}`)
                shim = this.terminalShim.install(
                    tab,
                    detected!,
                    shimDirectory,
                    [],
                    {
                        [KIMI_CODE_HOME_ENV]: hookHome.home,
                        [KIMI_HOOK_SESSION_ENV]: sessionId,
                        [KIMI_HOOK_TEMP_ENV]: tempName,
                    },
                    PASSTHROUGH_SUBCOMMANDS,
                )
            } catch (error) {
                this.removeTempRoot(tempRoot)
                this.ingress.unregisterFileDrop(sessionId)
                console.warn('[tabby-ai] could not install Kimi hook shim', error)
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

    private async prepareWslHome (
        tab: TerminalTabComponent,
        wslTarget: WslCliRuntimeTarget,
        tempRoot: string,
        dropDir: string,
        sessionId: string,
    ): Promise<{ home: string, hookCommand: string, fileDropRegistered: boolean }|null> {
        const curlPath = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'curl.exe')
        const mountRoot = wslTarget.windowsMountRoot
            ?? tab.profile.options['aiCli']?.windowsMountRoot
            ?? null
        const bridge = mountRoot
            ? {
                home: translateWindowsPathWithMountRoot(mountRoot, tempRoot),
                drop: translateWindowsPathWithMountRoot(mountRoot, dropDir),
                curl: translateWindowsPathWithMountRoot(mountRoot, curlPath),
                interop: wslTarget.windowsInterop === true,
            }
            : await this.probeWslBridge(wslTarget, tab, tempRoot, dropDir, curlPath)
        if (!bridge || sessionAppeared(tab)) {
            console.warn('[tabby-ai] session spawned during WSL Kimi hook bridge setup; full support skipped')
            return null
        }
        if (!bridge.home || !bridge.drop) {
            console.warn(`[tabby-ai] WSL hook bridge unavailable in ${wslTarget.distro}; Kimi will launch without full monitoring`)
            return null
        }

        if (sessionAppeared(tab)) {
            console.warn('[tabby-ai] Kimi session spawned during WSL path setup; full support skipped')
            return null
        }

        // Linking credentials/sessions is best-effort and must not race the PTY
        // spawn. Hooks only need config.toml + KIMI_CODE_HOME.
        void this.linkWslHome(wslTarget.distro, bridge.home)

        const interopWorks = bridge.interop && fs.existsSync(curlPath)
        const transport = selectWslHookTransport({
            dropAvailable: !!bridge.drop,
            curlAvailable: !!bridge.curl,
            interop: interopWorks,
        })
        if (transport === 'file') {
            this.ingress.registerFileDrop(sessionId, dropDir, 'kimi')
            return {
                home: bridge.home,
                hookCommand: wslDropHookCommand(bridge.drop, sessionId),
                fileDropRegistered: true,
            }
        }
        if (transport === 'curl' && bridge.curl) {
            return {
                home: bridge.home,
                hookCommand: kimiCurlHookCommand(bridge.curl, this.ingress.kimiEndpointFor(sessionId)),
                fileDropRegistered: false,
            }
        }
        console.warn(`[tabby-ai] WSL hook bridge unavailable in ${wslTarget.distro}; Kimi will launch without full monitoring`)
        return null
    }

    private async probeWslBridge (
        wslTarget: WslCliRuntimeTarget,
        tab: TerminalTabComponent,
        tempRoot: string,
        dropDir: string,
        curlPath: string,
    ): Promise<{ home: string|null, drop: string|null, curl: string|null, interop: boolean }|null> {
        const [home, drop, curl, interop] = await Promise.all([
            translateWindowsPathForWsl(wslTarget, tempRoot),
            translateWindowsPathForWsl(wslTarget, dropDir),
            translateWindowsPathForWsl(wslTarget, curlPath),
            fs.existsSync(curlPath)
                ? windowsExecutableRunsInWsl(wslTarget, curlPath)
                : Promise.resolve(false),
        ])
        if (tab.session) {
            return null
        }
        return { home, drop, curl, interop }
    }

    private async linkWslHome (distro: string, translatedHome: string): Promise<boolean> {
        // One shell line — Windows execFile is unreliable with embedded newlines,
        // and `do;` (from naive `; ` joins) is a syntax error.
        const script = [
            `TEMP=${quoteSh(translatedHome)}`,
            'REAL="$HOME/.kimi-code"',
            'mkdir -p "$TEMP/drop" || exit 1',
            'for d in credentials sessions user-history logs telemetry updates; do if [ -e "$REAL/$d" ]; then ln -sfn "$REAL/$d" "$TEMP/$d" || exit 1; fi; done',
            'for f in device_id tui.toml workspaces.json session_index.jsonl; do if [ -f "$REAL/$f" ]; then ln -sfn "$REAL/$f" "$TEMP/$f" || exit 1; fi; done',
        ].join('; ')
        const result = await runWsl(distro, ['--exec', '/bin/sh', '-c', script])
        return result !== null
    }

    private restoreRun (tab: TerminalTabComponent): boolean {
        const recovery = kimiHookRecovery(tab.profile.options.env)
        if (!recovery) {
            return false
        }
        const tempRoot = path.join(os.tmpdir(), recovery.tempName)
        const dropDir = path.join(tempRoot, KIMI_DROP_DIR_NAME)
        if (
            path.dirname(path.resolve(tempRoot)) !== path.resolve(os.tmpdir()) ||
            !path.basename(tempRoot).startsWith(KIMI_TEMP_DIR_PREFIX) ||
            !fs.existsSync(path.join(tempRoot, 'config.toml')) ||
            !fs.existsSync(dropDir)
        ) {
            return false
        }
        this.ingress.registerFileDrop(recovery.sessionId, dropDir, 'kimi')
        this.registerRun({
            tab,
            sessionId: recovery.sessionId,
            direct: true,
            shim: null,
            tempRoot,
            disposed: false,
        }, true)
        console.info(`[tabby-ai] restored Kimi hook route [${recovery.sessionId.slice(0, 8)}]`)
        return true
    }

    private registerRun (run: KimiRun, publishReady: boolean): void {
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

    private onSessionDown (run: KimiRun): void {
        setTimeout(() => {
            const snapshot = this.bus.snapshotFor(run.sessionId)
            if (snapshot && snapshot.lastEvent?.kind !== 'session-ended') {
                this.zone.run(() => this.bus.publish({
                    sessionId: run.sessionId,
                    ts: Date.now(),
                    kind: 'process-exited',
                    confidence: 'high',
                    summary: 'Kimi exited',
                }))
            }
        }, EXIT_GRACE_MS)
    }

    private dispose (run: KimiRun): void {
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
    }

    private removeTempRoot (directory: string): void {
        const resolved = path.resolve(directory)
        if (
            path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
            !path.basename(resolved).startsWith(KIMI_TEMP_DIR_PREFIX)
        ) {
            console.warn('[tabby-ai] refusing to remove unexpected Kimi temp directory')
            return
        }
        try {
            fs.rmSync(resolved, { recursive: true, force: true })
        } catch { /* already gone */ }
    }
}
