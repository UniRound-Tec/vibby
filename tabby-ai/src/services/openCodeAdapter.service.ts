import * as crypto from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { OpenCodeEventProjector } from '../opencodeEvents'
import { OpenCodeSseClient } from '../openCodeSse'
import { SHIM_DIR_PREFIX } from '../paths'
import { usesMirroredWslNetworking, wslIpv4Address } from '../runtimeTargets'
import { CliScannerService } from './cliScanner.service'
import { AiEventBusService } from './eventBus.service'
import { RuntimeCliDetectorService } from './runtimeCliDetector.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { TerminalCliShimInstallation, TerminalCliShimService } from './terminalCliShim.service'

const KIND = 'opencode'
const HOST = '127.0.0.1'
const MONITOR_MARKER = 'VIBBY_OPENCODE_MONITOR'
const PORT_MARKER = 'VIBBY_OPENCODE_PORT'

/**
 * Subcommands that operate on another server, mutate installation/config, or
 * only print local information. They must not inherit this pane's private
 * server credentials and do not produce a monitorable local event stream.
 */
const PASSTHROUGH_SUBCOMMANDS = [
    'acp',
    'agent',
    'attach',
    'auth',
    'completion',
    'db',
    'debug',
    'export',
    'github',
    'import',
    'mcp',
    'models',
    'plugin',
    'pr',
    'providers',
    'session',
    'stats',
    'uninstall',
    'upgrade',
]

interface OpenCodeRun {
    tab: TerminalTabComponent
    sessionId: string
    port: number
    host: string
    direct: boolean
    projector: OpenCodeEventProjector
    client: OpenCodeSseClient|null
    shim: TerminalCliShimInstallation|null
    tempRoot: string|null
    runtimeActive: boolean
    disposed: boolean
    persistedArgs: string[]
    persistedEnv: Record<string, string>
    profileDetached: boolean
}

function hasOption (args: string[], option: string): boolean {
    return args.some(arg => arg === option || arg.startsWith(`${option}=`))
}

function stripOption (args: string[], option: string): string[] {
    const result: string[] = []
    for (let i = 0; i < args.length; i++) {
        if (args[i] === option) {
            i++
        } else if (!args[i].startsWith(`${option}=`)) {
            result.push(args[i])
        }
    }
    return result
}

function withoutOldMonitorEnv (
    env: Record<string, string>,
    recovering: boolean,
): Record<string, string> {
    if (!recovering) {
        return { ...env }
    }
    const ephemeral = new Set([
        'OPENCODE_SERVER_USERNAME',
        'OPENCODE_SERVER_PASSWORD',
        MONITOR_MARKER,
        PORT_MARKER,
    ])
    return Object.fromEntries(Object.entries(env).filter(([key]) => !ephemeral.has(key)))
}

/** Reserve a loopback port just long enough to select it before PTY spawn. */
function allocatePort (): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.unref()
        server.once('error', reject)
        server.listen(0, HOST, () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                server.close()
                reject(new Error('could not allocate OpenCode monitor port'))
                return
            }
            server.close(error => error ? reject(error) : resolve(address.port))
        })
    })
}

/**
 * OpenCode full-listening adapter.
 *
 * Each pane owns a dedicated loopback-only OpenCode server. Native root/child
 * sessions are projected into the single Vibby pane session.
 *
 * OpenCode 1.17.9's embedded TUI client does not forward Basic Auth to its own
 * server, so TUI monitoring must rely on the loopback boundary. The transport
 * itself retains optional Basic Auth support for serve/web and future versions.
 */
@Injectable({ providedIn: 'root' })
export class OpenCodeAdapterService {
    private armed = new WeakSet<TerminalTabComponent>()
    private watchedSplits = new WeakSet<SplitTabComponent>()
    private runs = new WeakMap<TerminalTabComponent, OpenCodeRun>()

    constructor (
        private app: AppService,
        private scanner: CliScannerService,
        private runtimeDetector: RuntimeCliDetectorService,
        private terminalShim: TerminalCliShimService,
        private directory: AiSessionDirectoryService,
        private bus: AiEventBusService,
        private zone: NgZone,
    ) { }

    activate (): void {
        this.app.tabOpened$.subscribe(tab => this.visit(tab))
        this.app.tabsChanged$.subscribe(() => {
            for (const tab of this.app.tabs) {
                this.visit(tab)
            }
        })
        this.scanner.scanResults$.subscribe(() => {
            for (const tab of this.app.tabs) {
                this.visit(tab)
            }
        })
        this.runtimeDetector.changed$.subscribe(change => {
            const run = this.runs.get(change.pane)
            if (!run || run.direct) {
                return
            }
            if (change.kind === KIND) {
                this.startClient(run, true)
            } else if (run.runtimeActive) {
                this.stopClient(run)
            }
        })
        for (const tab of this.app.tabs) {
            this.visit(tab)
        }
    }

    private visit (tab: BaseTabComponent): void {
        if (tab instanceof SplitTabComponent) {
            if (!this.watchedSplits.has(tab)) {
                this.watchedSplits.add(tab)
                tab.tabAdded$.subscribe(child => this.visit(child))
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
        const detected = direct
            ? null
            : this.scanner.scanResults.find(item =>
                item.entry.id === KIND && item.target.type === 'native',
            ) ?? null
        if (!direct && !detected) {
            return
        }
        this.armed.add(tab)

        const oldEnv = tab.profile.options.env
        const recovering = oldEnv[MONITOR_MARKER] === '1'
        const persistedEnv = withoutOldMonitorEnv(oldEnv, recovering)
        let args = tab.profile.options.args.slice()
        if (recovering) {
            args = stripOption(stripOption(args, '--hostname'), '--port')
        } else if (direct && (hasOption(args, '--hostname') || hasOption(args, '--port'))) {
            console.warn('[tabby-ai] OpenCode already has an explicit host/port; full listening skipped')
            return
        }

        let host = HOST
        const targetId = direct ? tab.profile.options['aiCli']?.targetId : null
        const wslTarget = direct
            ? this.scanner.runtimeTargets.find(target => target.id === targetId && target.type === 'wsl')
            : null
        if (wslTarget?.type === 'wsl' && wslTarget.wslVersion !== 1 && !usesMirroredWslNetworking()) {
            host = await wslIpv4Address(wslTarget) ?? ''
            if (!host) {
                console.warn(`[tabby-ai] could not resolve WSL address for ${wslTarget.distro}; full listening skipped`)
                return
            }
        }

        let port = 0
        try {
            port = await allocatePort()
        } catch (error) {
            console.warn('[tabby-ai] could not allocate OpenCode monitor port', error)
            return
        }
        if (tab.session) {
            console.warn('[tabby-ai] OpenCode session spawned before monitor injection; full listening skipped')
            return
        }

        const sessionId = crypto.randomUUID()
        const monitorArgs = ['--hostname', host, '--port', String(port)]
        const monitorEnv = {
            [MONITOR_MARKER]: '1',
            [PORT_MARKER]: String(port),
        }
        let shim: TerminalCliShimInstallation|null = null
        let tempRoot: string|null = null

        try {
            if (direct) {
                tab.profile.options.args = [...args, ...monitorArgs]
                tab.profile.options.env = { ...persistedEnv, ...monitorEnv }
            } else {
                tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibby-opencode-'))
                const shimDirectory = path.join(tempRoot, `${SHIM_DIR_PREFIX}${process.pid}-${sessionId}`)
                shim = this.terminalShim.install(
                    tab,
                    detected!,
                    shimDirectory,
                    monitorArgs,
                    monitorEnv,
                    PASSTHROUGH_SUBCOMMANDS,
                )
            }
        } catch (error) {
            if (tempRoot) {
                this.removeTempRoot(tempRoot)
            }
            console.error('[tabby-ai] could not install OpenCode monitor shim', error)
            return
        }

        const run: OpenCodeRun = {
            tab,
            sessionId,
            port,
            host,
            direct,
            projector: new OpenCodeEventProjector(sessionId),
            client: null,
            shim,
            tempRoot,
            runtimeActive: false,
            disposed: false,
            persistedArgs: args,
            persistedEnv,
            profileDetached: false,
        }
        this.runs.set(tab, run)
        this.directory.bind({ sessionId, kind: KIND, pane: tab })

        tab.sessionChanged$.subscribe(session => {
            if (session) {
                this.detachRuntimeSecretsFromProfile(run)
            }
            if (direct && session) {
                this.startClient(run, false)
            }
            session?.destroyed$.subscribe(() => {
                if (direct) {
                    this.onDirectSessionDown(run)
                }
            })
        })
        tab.destroyed$.subscribe(() => this.dispose(run))
    }

    private startClient (run: OpenCodeRun, freshRuntime: boolean): void {
        if (run.disposed || run.client) {
            return
        }
        run.runtimeActive = true
        if (freshRuntime) {
            run.projector = new OpenCodeEventProjector(run.sessionId)
        }
        run.client = new OpenCodeSseClient({
            endpoint: `http://${run.host}:${run.port}`,
            directory: run.tab.profile.options['aiCli']?.targetCwd ?? run.tab.profile.options.cwd,
            onEvent: payload => this.publish(run, run.projector.apply(payload, Date.now())),
            onStatuses: payload => this.publish(run, run.projector.reconcileStatuses(payload, Date.now())),
            onFailure: (error, fatal) => {
                // Errors are deliberately credential-free and transport
                // failures never overwrite the model session's business state.
                const severity = fatal ? 'fatal' : 'retrying'
                console.warn(`[tabby-ai] OpenCode monitor ${severity}: ${error.message}`)
            },
        })
        run.client.start()
    }

    /**
     * Session.start() has already copied options into the child environment.
     * Remove ephemeral credentials/port/shim from the recovery profile so
     * saved tabs never persist live secrets or stale generated paths.
     */
    private detachRuntimeSecretsFromProfile (run: OpenCodeRun): void {
        if (run.profileDetached) {
            return
        }
        run.profileDetached = true
        if (run.direct) {
            run.tab.profile.options.args = run.persistedArgs
            run.tab.profile.options.env = run.persistedEnv
        } else if (run.shim) {
            run.tab.profile.options.pathPrefix =
                run.tab.profile.options.pathPrefix.filter(item => item !== run.shim!.directory)
        }
    }

    private stopClient (run: OpenCodeRun): void {
        run.client?.stop()
        run.client = null
        run.runtimeActive = false
    }

    private publish (run: OpenCodeRun, event: ReturnType<OpenCodeEventProjector['apply']>): void {
        if (!event || run.disposed) {
            return
        }
        this.zone.run(() => this.bus.publish(event))
    }

    private onDirectSessionDown (run: OpenCodeRun): void {
        this.stopClient(run)
        const snapshot = this.bus.snapshotFor(run.sessionId)
        if (snapshot?.state === 'working' || snapshot?.state === 'needs-you') {
            this.zone.run(() => this.bus.publish({
                sessionId: run.sessionId,
                ts: Date.now(),
                kind: 'process-exited',
                confidence: 'high',
                summary: 'OpenCode exited',
            }))
        }
    }

    private dispose (run: OpenCodeRun): void {
        if (run.disposed) {
            return
        }
        run.disposed = true
        this.stopClient(run)
        run.shim?.remove()
        if (run.tempRoot) {
            this.removeTempRoot(run.tempRoot)
        }
        this.directory.unbind(run.sessionId)
        this.zone.run(() => this.bus.dropSession(run.sessionId))
    }

    private removeTempRoot (directory: string): void {
        const expectedParent = path.resolve(os.tmpdir())
        const resolved = path.resolve(directory)
        if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('vibby-opencode-')) {
            console.warn('[tabby-ai] refusing to remove unexpected OpenCode temp directory')
            return
        }
        try {
            fs.rmSync(resolved, { recursive: true, force: true })
        } catch { /* already gone */ }
    }
}
