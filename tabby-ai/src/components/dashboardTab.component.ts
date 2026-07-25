import { Component, ElementRef, Injector } from '@angular/core'
import { DomSanitizer, SafeHtml } from '@angular/platform-browser'
import { interval } from 'rxjs'
import { BaseTabComponent, AppService, ConfigService, ProfilesService, SplitTabComponent, TranslateService } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { DetectedCli } from '../api'
import { AiEvent, AiSessionSnapshot } from '../events'
import { AI_CLI_REGISTRY } from '../registry'
import { CliScannerService } from '../services/cliScanner.service'
import { AiEventBusService } from '../services/eventBus.service'
import { ClaudeAdapterService } from '../services/claudeAdapter.service'

export type AiRowState = 'needs-you' | 'working' | 'idle' | 'error' | 'untracked'

export interface AiSessionRow {
    topTab: BaseTabComponent
    pane: TerminalTabComponent
    kind: string|null
    sessionId: string|null
    snapshot: AiSessionSnapshot|null
    state: AiRowState
}

const STATE_RANK: Record<AiRowState, number> = {
    'needs-you': 0,
    working: 1,
    idle: 2,
    error: 3,
    untracked: 4,
}

/** @hidden */
@Component({
    selector: 'ai-dashboard-tab',
    templateUrl: './dashboardTab.component.pug',
    styleUrls: ['./dashboardTab.component.scss'],
})
export class DashboardTabComponent extends BaseTabComponent {
    /** Renders the tab header as a compact icon-only tab (tabHeader.component.ts hook) */
    miniHeader = true

    rows: AiSessionRow[] = []
    counters: { state: AiRowState, count: number }[] = []
    clis: DetectedCli[] = []
    scanning = false
    now = Date.now()

    private snapshots: ReadonlyMap<string, AiSessionSnapshot> = new Map()
    private watchedSplits = new Set<SplitTabComponent>()
    private iconCache = new Map<string, SafeHtml>()

    constructor (
        injector: Injector,
        private app: AppService,
        private configService: ConfigService,
        private profilesService: ProfilesService,
        private scanner: CliScannerService,
        private bus: AiEventBusService,
        private adapter: ClaudeAdapterService,
        private sanitizer: DomSanitizer,
        private host: ElementRef,
        private translate: TranslateService,
    ) {
        super(injector)
        this.setTitle(translate.instant('Home'))
        this.subscribeUntilDestroyed(this.app.tabsChanged$, () => this.refreshRows())
        this.subscribeUntilDestroyed(this.bus.snapshots$, snapshots => {
            this.snapshots = snapshots
            this.refreshRows()
        })
        this.subscribeUntilDestroyed(this.scanner.scanResults$, clis => this.clis = clis)
        this.subscribeUntilDestroyed(this.scanner.scanning$, scanning => this.scanning = scanning)
        this.subscribeUntilDestroyed(this.configService.changed$, () => this.applyThemeVars())
        this.subscribeUntilDestroyed(interval(5000), () => this.now = Date.now())
        this.refreshRows()
        this.scanner.ensureScanned()
    }

    ngOnInit (): void {
        this.applyThemeVars()
    }

    refreshRows (): void {
        const rows: AiSessionRow[] = []
        for (const topTab of this.app.tabs) {
            const panes = topTab instanceof SplitTabComponent ? topTab.getAllTabs() : [topTab]
            if (topTab instanceof SplitTabComponent && !this.watchedSplits.has(topTab)) {
                this.watchedSplits.add(topTab)
                this.subscribeUntilDestroyed(topTab.tabAdded$, () => this.refreshRows())
                this.subscribeUntilDestroyed(topTab.tabRemoved$, () => this.refreshRows())
            }
            for (const pane of panes) {
                if (pane instanceof TerminalTabComponent && pane.profile?.type === 'ai-cli') {
                    const sessionId = this.adapter.sessionIdForPane(pane)
                    const snapshot = sessionId ? this.snapshots.get(sessionId) ?? null : null
                    rows.push({
                        topTab,
                        pane,
                        kind: pane.profile.options?.['aiCli']?.kind ?? null,
                        sessionId,
                        snapshot,
                        state: snapshot?.state ?? 'untracked',
                    })
                }
            }
        }
        rows.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])
        this.rows = rows

        const counts = new Map<AiRowState, number>()
        for (const row of rows) {
            counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
        }
        this.counters = [...counts.entries()]
            .sort((a, b) => STATE_RANK[a[0]] - STATE_RANK[b[0]])
            .map(([state, count]) => ({ state, count }))
    }

    stateLabel (state: AiRowState): string {
        switch (state) {
            case 'needs-you': return this.translate.instant('Needs you')
            case 'working': return this.translate.instant('Working')
            case 'idle': return this.translate.instant('Idle')
            case 'error': return this.translate.instant('Error')
            case 'untracked': return this.translate.instant('Untracked')
        }
    }

    /** What the session last did — the hook event, high confidence */
    captionFor (row: AiSessionRow): string {
        if (!row.snapshot) {
            return this.translate.instant('Launch only · no event monitoring yet')
        }
        return row.snapshot.lastEvent?.summary ?? ''
    }

    /** That it is still alive — the CLI's own status line, scraped, low confidence */
    liveFor (row: AiSessionRow): string {
        return row.snapshot?.liveStatus ?? ''
    }

    durationFor (row: AiSessionRow): string {
        if (!row.snapshot) {
            return ''
        }
        const seconds = Math.max(0, Math.floor((this.now - row.snapshot.since) / 1000))
        if (seconds < 60) {
            return `${seconds}s`
        }
        const minutes = Math.floor(seconds / 60)
        if (minutes < 60) {
            return `${minutes}m ${seconds % 60}s`
        }
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    }

    feedFor (row: AiSessionRow): AiEvent[] {
        return row.sessionId ? this.bus.feedFor(row.sessionId) : []
    }

    feedTime (event: AiEvent): string {
        const d = new Date(event.ts)
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    focusRow (row: AiSessionRow): void {
        this.app.selectTab(row.topTab)
        if (row.topTab instanceof SplitTabComponent) {
            row.topTab.focus(row.pane)
        }
    }

    async launch (cli: DetectedCli): Promise<void> {
        const profiles = await this.profilesService.getProfiles()
        const profile = profiles.find(x => x.id === `ai-cli:${cli.entry.id}`)
        if (profile) {
            await this.profilesService.launchProfile(profile)
        }
    }

    rescan (): void {
        this.scanner.scan()
    }

    iconForKind (kind: string|null): SafeHtml|null {
        if (!kind) {
            return null
        }
        if (!this.iconCache.has(kind)) {
            const entry = AI_CLI_REGISTRY.find(x => x.id === kind)
            if (!entry) {
                return null
            }
            this.iconCache.set(kind, this.sanitizer.bypassSecurityTrustHtml(entry.icon))
        }
        return this.iconCache.get(kind) ?? null
    }

    private applyThemeVars (): void {
        const style = this.host.nativeElement.style
        const terminal = this.configService.store.terminal ?? {}
        const colors: string[] = terminal.colorScheme?.colors ?? []
        style.setProperty('--ai-mono', terminal.font ?? 'monospace')
        style.setProperty('--ai-red', colors[1] ?? '#e06c75')
        style.setProperty('--ai-green', colors[2] ?? '#98c379')
        style.setProperty('--ai-yellow', colors[3] ?? '#f0c674')
        style.setProperty('--ai-blue', colors[4] ?? '#61afef')
    }
}
