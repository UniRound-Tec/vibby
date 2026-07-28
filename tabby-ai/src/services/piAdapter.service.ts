import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { DetectedCli } from '../api'
import {
    PI_HOOK_DROP_DIR_ENV,
    PI_HOOK_ENDPOINT_ENV,
    PI_HOOK_LOG_ENV,
    PI_HOOK_SESSION_ENV,
    PI_EXTENSION_FILE_NAME,
    buildPiExtensionSource,
    injectPiExtensionArgs,
    piHookEnvironment,
    piWslDistroFromArgs,
    withoutStalePiHookArgs,
} from '../piHooks'
import { SHIM_DIR_PREFIX } from '../paths'
import {
    translateWindowsPathForWsl,
    translateWindowsPathWithMountRoot,
} from '../runtimeTargets'
import { AiEventBusService } from './eventBus.service'
import { CliScannerService } from './cliScanner.service'
import { HookIngressService } from './hookIngress.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { TerminalCliShimInstallation, TerminalCliShimService } from './terminalCliShim.service'

const KIND = 'pi'
const EXIT_GRACE_MS = 500
const TEMP_DIR_PREFIX = 'vibby-pi-'

const PASSTHROUGH_SUBCOMMANDS = [
    'install',
    'remove',
    'uninstall',
    'update',
    'list',
    'config',
    'help',
    '--version',
]

interface PiRun {
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

function withoutStaleHookEnv (env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) =>
            key !== PI_HOOK_ENDPOINT_ENV &&
            key !== PI_HOOK_DROP_DIR_ENV &&
            key !== PI_HOOK_SESSION_ENV &&
            key !== PI_HOOK_LOG_ENV,
        ),
    )
}

/**
 * Pi monitoring uses a generated TypeScript extension loaded by `pi -e`.
 * The extension forwards Pi lifecycle hooks to vibby's HookIngressService,
 * either over HTTP (native) or via the WSL file-drop bridge.
 */
@Injectable({ providedIn: 'root' })
export class PiAdapterService {
    private armed = new WeakSet<TerminalTabComponent>()
    private arming = new WeakSet<TerminalTabComponent>()
    private watchedSplits = new WeakSet<SplitTabComponent>()
    private runs = new WeakMap<TerminalTabComponent, PiRun>()

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
        if (direct) {
            // Also sanitize already-running restored tabs so their next
            // recovery token cannot keep a dead temporary extension path.
            tab.profile.options.args = withoutStalePiHookArgs([...tab.profile.options.args])
            tab.profile.options.env = withoutStaleHookEnv({ ...tab.profile.options.env })
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
        const originalArgs = withoutStalePiHookArgs([...tab.profile.options.args])
        const originalEnv = withoutStaleHookEnv({ ...tab.profile.options.env })
        if (direct) {
            // Remove only Vibby's stale extension before the first await. A
            // restored PTY may spawn while scanner/ingress startup is pending.
            tab.profile.options.args = originalArgs
            tab.profile.options.env = originalEnv
        }

        const aiCli = tab.profile.options['aiCli']
        const targetId = aiCli?.targetId
        const storedMountRoot = aiCli?.windowsMountRoot
        const wrappedWslDistro = piWslDistroFromArgs(originalArgs)
        try {
            await Promise.all([
                this.ingress.start(),
                wrappedWslDistro && !storedMountRoot
                    ? this.scanner.ensureScanned()
                    : Promise.resolve(),
            ])
        } catch (error) {
            console.warn('[tabby-ai] Pi hook prerequisites unavailable', error)
            return
        }
        if (sessionAppeared(tab)) {
            console.warn('[tabby-ai] Pi session spawned before hook injection; full support skipped')
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
        const mountRoot = wslTarget?.type === 'wsl'
            ? wslTarget.windowsMountRoot ?? storedMountRoot
            : storedMountRoot
        if (wslTarget?.type === 'wsl' && aiCli && !aiCli.windowsMountRoot) {
            aiCli.windowsMountRoot = wslTarget.windowsMountRoot
        }
        if (direct && wrappedWslDistro && !wslTarget && !mountRoot) {
            console.warn(`[tabby-ai] WSL target metadata unavailable for ${wrappedWslDistro}; Pi will launch without full monitoring`)
            return
        }

        let tempRoot: string|null = null
        let shim: TerminalCliShimInstallation|null = null

        try {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX))
        } catch (error) {
            console.warn('[tabby-ai] could not create the Pi hook temp directory', error)
            return
        }

        const extensionPath = path.join(tempRoot, PI_EXTENSION_FILE_NAME)
        try {
            fs.writeFileSync(
                extensionPath,
                buildPiExtensionSource(),
                { mode: 0o600 },
            )
        } catch (error) {
            this.removeTempRoot(tempRoot)
            console.warn('[tabby-ai] could not write the Pi hook extension', error)
            return
        }

        const endpoint = this.ingress.piEndpointFor(sessionId)
        const logPath = path.join(tempRoot, 'vibby-pi-extension.log')

        if (wrappedWslDistro) {
            const translatedExtension = mountRoot
                ? translateWindowsPathWithMountRoot(mountRoot, extensionPath)
                : wslTarget?.type === 'wsl'
                    ? await translateWindowsPathForWsl(wslTarget, extensionPath)
                    : null
            if (sessionAppeared(tab) || !translatedExtension) {
                this.removeTempRoot(tempRoot)
                console.warn(`[tabby-ai] WSL path translation unavailable in ${wrappedWslDistro}; Pi will launch without full monitoring`)
                return
            }

            const translatedDrop = mountRoot
                ? translateWindowsPathWithMountRoot(mountRoot, tempRoot)
                : wslTarget?.type === 'wsl'
                    ? await translateWindowsPathForWsl(wslTarget, tempRoot)
                    : null
            if (sessionAppeared(tab) || !translatedDrop) {
                this.removeTempRoot(tempRoot)
                console.warn(`[tabby-ai] WSL hook bridge unavailable in ${wrappedWslDistro}; Pi will launch without full monitoring`)
                return
            }

            const inheritedWslenv = Object.prototype.hasOwnProperty.call(originalEnv, 'WSLENV')
                ? originalEnv['WSLENV']
                : process.env.WSLENV ?? ''
            const wslEnv = piHookEnvironment(
                endpoint,
                translatedDrop,
                sessionId,
                {
                    ...originalEnv,
                    WSLENV: inheritedWslenv,
                },
                path.posix.join(translatedDrop, 'vibby-pi-extension.log'),
            )
            this.ingress.registerFileDrop(sessionId, tempRoot, 'pi')

            if (direct) {
                tab.profile.options.args = injectPiExtensionArgs(originalArgs, translatedExtension)
                tab.profile.options.env = wslEnv
            }
        } else {
            if (direct) {
                tab.profile.options.args = injectPiExtensionArgs(originalArgs, extensionPath)
                tab.profile.options.env = piHookEnvironment(endpoint, null, undefined, originalEnv, logPath)
            }
        }

        if (!direct) {
            try {
                const shimDirectory = path.join(tempRoot, `${SHIM_DIR_PREFIX}${process.pid}-${sessionId}`)
                shim = this.terminalShim.install(
                    tab,
                    detected!,
                    shimDirectory,
                    ['-e', extensionPath],
                    piHookEnvironment(endpoint, null, undefined, {}, logPath),
                    PASSTHROUGH_SUBCOMMANDS,
                )
            } catch (error) {
                this.removeTempRoot(tempRoot)
                console.warn('[tabby-ai] could not install Pi hook shim', error)
                return
            }
        }

        const run: PiRun = {
            tab,
            sessionId,
            direct,
            shim,
            tempRoot,
            disposed: false,
        }
        this.runs.set(tab, run)
        this.armed.add(tab)
        this.directory.bind({ sessionId, kind: KIND, pane: tab })

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

    private onSessionDown (run: PiRun): void {
        setTimeout(() => {
            const snapshot = this.bus.snapshotFor(run.sessionId)
            if (snapshot && snapshot.lastEvent?.kind !== 'session-ended') {
                this.zone.run(() => this.bus.publish({
                    sessionId: run.sessionId,
                    ts: Date.now(),
                    kind: 'process-exited',
                    confidence: 'high',
                    summary: 'Pi exited',
                }))
            }
        }, EXIT_GRACE_MS)
    }

    private dispose (run: PiRun): void {
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
            !path.basename(resolved).startsWith(TEMP_DIR_PREFIX)
        ) {
            console.warn('[tabby-ai] refusing to remove unexpected Pi temp directory')
            return
        }
        try {
            fs.rmSync(resolved, { recursive: true, force: true })
        } catch { /* already gone */ }
    }
}
