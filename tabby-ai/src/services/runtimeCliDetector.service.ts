import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { matchCli } from '../cliMatch'
import { AI_CLI_REGISTRY } from '../registry'

const POLL_INTERVAL_MS = 1200

/**
 * Reading a pane's process tree is not free — on Windows it walks every
 * process and reads its command line out of the PEB. A pane whose answer keeps
 * coming back the same is asked less often: every tick, then every 2nd, up to
 * every 4th (~4.8s). Any change, and it goes back to the fast lane.
 */
const MAX_BACKOFF = 4

/** Consecutive unchanged scans before the interval widens one step */
const STABLE_SCANS_PER_STEP = 4

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
    private tick = 0
    /** Consecutive scans in which this pane reported the same thing */
    private stableScans = new WeakMap<TerminalTabComponent, number>()

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
        if (this.scanPending || document.hidden) {
            return
        }
        this.scanPending = true
        this.tick++
        try {
            const panes = this.localPanes().filter(pane => pane.profile?.type !== 'ai-cli' && !!pane.session)
            const current = new Set(panes)
            // the pane the user is looking at never backs off — starting a CLI
            // in it should light the rail up now, not up to five seconds later
            const foreground = new Set(this.app.activeTab ? this.panesOf(this.app.activeTab) : [])
            await Promise.all(
                panes.filter(pane => foreground.has(pane) || this.isDue(pane))
                    .map(pane => this.scanPane(pane)),
            )
            for (const pane of [...this.detectedPanes]) {
                if (!current.has(pane)) {
                    this.update(pane, null)
                }
            }
        } finally {
            this.scanPending = false
        }
    }

    /** Backoff gate: a pane that keeps answering the same is skipped on most ticks */
    private isDue (pane: TerminalTabComponent): boolean {
        const stable = this.stableScans.get(pane) ?? 0
        const stride = Math.min(MAX_BACKOFF, 1 + Math.floor(stable / STABLE_SCANS_PER_STEP))
        return this.tick % stride === 0
    }

    private async scanPane (pane: TerminalTabComponent): Promise<void> {
        let kind: string|null = null
        try {
            kind = matchCli(await pane.session!.getChildProcesses(), AI_CLI_REGISTRY)
        } catch {
            // Process inspection is best-effort and can race a closing PTY.
        }
        this.update(pane, kind)
    }

    private update (pane: TerminalTabComponent, kind: string|null): void {
        const previous = this.runtimeKinds.get(pane) ?? null
        if (previous === kind) {
            this.stableScans.set(pane, (this.stableScans.get(pane) ?? 0) + 1)
            return
        }
        this.stableScans.set(pane, 0)
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
