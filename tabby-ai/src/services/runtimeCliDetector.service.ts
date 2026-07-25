import * as path from 'path'
import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { ChildProcess, TerminalTabComponent } from 'tabby-local'

import { AI_CLI_REGISTRY } from '../registry'

const POLL_INTERVAL_MS = 1200
const EXECUTABLE_SUFFIX_RE = /\.(?:exe|cmd|bat|ps1|sh|js|mjs|cjs|py)$/i

export interface RuntimeCliChange {
    pane: TerminalTabComponent
    kind: string|null
}

/**
 * Detects supported CLIs started manually inside an ordinary local terminal.
 * This is intentionally runtime-only: changing the terminal profile would
 * make recovery try to launch the CLI instead of restoring the user's shell.
 */
@Injectable({ providedIn: 'root' })
export class RuntimeCliDetectorService {
    readonly changed$ = new Subject<RuntimeCliChange>()

    private runtimeKinds = new WeakMap<TerminalTabComponent, string>()
    private detectedPanes = new Set<TerminalTabComponent>()
    private timer: any = null
    private scanPending = false

    constructor (
        private app: AppService,
        private zone: NgZone,
    ) { }

    activate (): void {
        if (this.timer) {
            return
        }
        this.zone.runOutsideAngular(() => {
            this.timer = setInterval(() => this.scan(), POLL_INTERVAL_MS)
        })
        this.scan()
    }

    kindForPane (pane: TerminalTabComponent): string|null {
        if (pane.profile?.type === 'ai-cli') {
            return pane.profile.options?.['aiCli']?.kind ?? null
        }
        return this.runtimeKinds.get(pane) ?? null
    }

    isRuntimeDetected (pane: TerminalTabComponent): boolean {
        return pane.profile?.type !== 'ai-cli' && this.runtimeKinds.has(pane)
    }

    private async scan (): Promise<void> {
        if (this.scanPending) {
            return
        }
        this.scanPending = true
        try {
            const panes = this.localPanes().filter(pane => pane.profile?.type !== 'ai-cli' && !!pane.session)
            const current = new Set(panes)
            await Promise.all(panes.map(pane => this.scanPane(pane)))
            for (const pane of [...this.detectedPanes]) {
                if (!current.has(pane)) {
                    this.update(pane, null)
                }
            }
        } finally {
            this.scanPending = false
        }
    }

    private async scanPane (pane: TerminalTabComponent): Promise<void> {
        let kind: string|null = null
        try {
            kind = this.detect(await pane.session!.getChildProcesses())
        } catch {
            // Process inspection is best-effort and can race a closing PTY.
        }
        this.update(pane, kind)
    }

    private detect (processes: ChildProcess[]): string|null {
        for (const entry of AI_CLI_REGISTRY) {
            const binaries = entry.binaries.map(binary => binary.toLowerCase())
            for (const process of processes) {
                if (binaries.includes(this.executableName(process.command))) {
                    return entry.id
                }
                const commandLine = process.commandLine?.toLowerCase() ?? ''
                if (entry.runtimeMarkers?.some(marker => commandLine.includes(marker.toLowerCase()))) {
                    return entry.id
                }
                if (this.commandTokens(commandLine).some(token => binaries.includes(this.executableName(token)))) {
                    return entry.id
                }
            }
        }
        return null
    }

    private commandTokens (commandLine: string): string[] {
        return commandLine.match(/"[^"]*"|'[^']*'|\S+/g)?.map(token => token.replace(/^["']|["']$/g, '')) ?? []
    }

    private executableName (command: string): string {
        return path.basename(command).replace(EXECUTABLE_SUFFIX_RE, '').toLowerCase()
    }

    private update (pane: TerminalTabComponent, kind: string|null): void {
        const previous = this.runtimeKinds.get(pane) ?? null
        if (previous === kind) {
            return
        }
        if (kind) {
            this.runtimeKinds.set(pane, kind)
            this.detectedPanes.add(pane)
        } else {
            this.runtimeKinds.delete(pane)
            this.detectedPanes.delete(pane)
        }
        this.zone.run(() => this.changed$.next({ pane, kind }))
    }

    private localPanes (): TerminalTabComponent[] {
        const panes: TerminalTabComponent[] = []
        for (const tab of this.app.tabs) {
            for (const pane of this.panesOf(tab)) {
                if (pane instanceof TerminalTabComponent) {
                    panes.push(pane)
                }
            }
        }
        return panes
    }

    private panesOf (tab: BaseTabComponent): BaseTabComponent[] {
        return tab instanceof SplitTabComponent ? tab.getAllTabs() : [tab]
    }
}
