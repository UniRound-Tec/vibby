import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import {
    PI_HOOK_DROP_DIR_ENV,
    PI_HOOK_ENDPOINT_ENV,
    PI_HOOK_SESSION_ENV,
    buildPiExtensionSource,
} from '../piHooks'
import { SHIM_DIR_PREFIX } from '../paths'
import {
    appendWslenv,
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
const EXTENSION_FILE_NAME = 'vibby-extension.ts'

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

function withoutStaleHookArgs (args: string[]): string[] {
    const clean: string[] = []
    for (let i = 0; i < args.length; i++) {
        if (
            args[i] === '-e' ||
            args[i] === '--extension'
        ) {
            i++
        } else if (
            args[i].startsWith('--extension=')
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
            key !== PI_HOOK_ENDPOINT_ENV &&
            key !== PI_HOOK_DROP_DIR_ENV &&
            key !== PI_HOOK_SESSION_ENV,
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
    private watchedSplits = new WeakSet<SplitTabComponent>()
    private runs = new WeakMap<TerminalTabComponent, PiRun>()
    private panes = new Map<string, TerminalTabComponent>()

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
        if (tab.session) {
            return
        }
        this.armed.add(tab)
        try {
            await this.ingress.start()
        } catch (error) {
            console.warn('[tabby-ai] Pi hook ingress unavailable', error)
            return
        }
        if (sessionAppeared(tab)) {
            console.warn('[tabby-ai] Pi session spawned before hook injection; full support skipped')
            return
        }

        const sessionId = crypto.randomUUID()
        const originalArgs = withoutStaleHookArgs([...tab.profile.options.args])
        const originalEnv = withoutStaleHookEnv({ ...tab.profile.options.env })
        const targetId = tab.profile.options['aiCli']?.targetId
        const wslTarget = direct
            ? this.scanner.runtimeTargets.find(target => target.id === targetId && target.type === 'wsl')
            : null

        let tempRoot: string|null = null
        let shim: TerminalCliShimInstallation|null = null

        try {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX))
        } catch (error) {
            console.warn('[tabby-ai] could not create the Pi hook temp directory', error)
            return
        }

        const extensionPath = path.join(tempRoot, EXTENSION_FILE_NAME)
        try {
            fs.writeFileSync(
                extensionPath,
                buildPiExtensionSource('', tempRoot, sessionId),
                { mode: 0o600 },
            )
        } catch (error) {
            this.removeTempRoot(tempRoot)
            console.warn('[tabby-ai] could not write the Pi hook extension', error)
            return
        }

        const injectedEnv: Record<string, string> = {
            [PI_HOOK_ENDPOINT_ENV]: this.ingress.piEndpointFor(sessionId),
        }

        if (wslTarget?.type === 'wsl') {
            const translatedExtension = wslTarget.windowsMountRoot
                ? translateWindowsPathWithMountRoot(wslTarget.windowsMountRoot, extensionPath)
                : await translateWindowsPathForWsl(wslTarget, extensionPath)
            if (sessionAppeared(tab) || !translatedExtension) {
                this.removeTempRoot(tempRoot)
                console.warn(`[tabby-ai] WSL path translation unavailable in ${wslTarget.distro}; Pi will launch without full monitoring`)
                return
            }

            const translatedDrop = wslTarget.windowsMountRoot
                ? translateWindowsPathWithMountRoot(wslTarget.windowsMountRoot, tempRoot)
                : await translateWindowsPathForWsl(wslTarget, tempRoot)
            if (sessionAppeared(tab) || !translatedDrop) {
                this.removeTempRoot(tempRoot)
                console.warn(`[tabby-ai] WSL hook bridge unavailable in ${wslTarget.distro}; Pi will launch without full monitoring`)
                return
            }

            injectedEnv[PI_HOOK_DROP_DIR_ENV] = translatedDrop
            injectedEnv[PI_HOOK_SESSION_ENV] = sessionId
            injectedEnv['WSLENV'] = appendWslenv(
                originalEnv['WSLENV'] || process.env.WSLENV,
                [PI_HOOK_DROP_DIR_ENV, PI_HOOK_SESSION_ENV],
            )
            this.ingress.registerFileDrop(sessionId, tempRoot, 'pi')

            if (direct) {
                tab.profile.options.args = ['-e', translatedExtension, ...originalArgs]
                tab.profile.options.env = { ...originalEnv, ...injectedEnv }
            }
        } else {
            if (direct) {
                tab.profile.options.args = ['-e', extensionPath, ...originalArgs]
                tab.profile.options.env = { ...originalEnv, ...injectedEnv }
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
                    { [PI_HOOK_ENDPOINT_ENV]: this.ingress.piEndpointFor(sessionId) },
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
        this.directory.bind({ sessionId, kind: KIND, pane: tab })
        this.panes.set(sessionId, tab)

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
        this.panes.delete(run.sessionId)
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
