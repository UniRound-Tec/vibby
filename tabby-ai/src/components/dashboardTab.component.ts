import { Component, ElementRef, Injector } from '@angular/core'
import { DomSanitizer, SafeHtml } from '@angular/platform-browser'
import { interval } from 'rxjs'
import { BaseTabComponent, AppService, ConfigService, ProfilesService, SplitTabComponent, TranslateService } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { AiCliRegistryEntry, DetectedCli } from '../api'
import { VIBBY_WORDMARK } from '../branding'
import { AiEvent, AiEventKind, AiSessionSnapshot, stateAfter } from '../events'
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

export interface AiCliLaunchCard {
    entry: AiCliRegistryEntry
    detected: DetectedCli|null
}

/** Rows shown in the activity timeline — the bus keeps more than anyone wants to read */
const TIMELINE_LENGTH = 20
const SESSION_PAGE_SIZE = 4
const ACTIVITY_PAGE_SIZE = 6
const LAUNCH_PAGE_SIZE = 6

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
    recent: AiEvent[] = []
    sessionPage = 0
    activityPage = 0
    launchPage = 0

    /** Mirrors tabby's own Tabs location setting — same store key, same values */
    readonly tabsLocations = [
        { value: 'left', label: 'Left' },
        { value: 'top', label: 'Top' },
        { value: 'right', label: 'Right' },
        { value: 'bottom', label: 'Bottom' },
    ]

    cliCards: AiCliLaunchCard[] = AI_CLI_REGISTRY.map(entry => ({ entry, detected: null }))
    scanning = false
    now = Date.now()
    readonly wordmark = VIBBY_WORDMARK
    readonly terminalIcon: SafeHtml

    private snapshots: ReadonlyMap<string, AiSessionSnapshot> = new Map()
    private watchedSplits = new Set<SplitTabComponent>()
    private iconCache = new Map<string, SafeHtml>()
    /** Only for panes whose profile carries no cwd — asked once per pane, never per render */
    private liveCwdNames = new Map<TerminalTabComponent, string>()
    private cwdAsked = new WeakSet<TerminalTabComponent>()
    /** Outlives the rows: the timeline still names sessions whose tab is long gone */
    private sessionNames = new Map<string, string>()

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
        this.terminalIcon = sanitizer.bypassSecurityTrustHtml(require('../icons/terminal.svg'))
        this.setTitle(translate.instant('Home'))
        this.subscribeUntilDestroyed(this.app.tabsChanged$, () => this.refreshRows())
        this.subscribeUntilDestroyed(this.bus.snapshots$, snapshots => {
            this.snapshots = snapshots
            this.recent = this.bus.recentEvents.slice(0, TIMELINE_LENGTH)
            this.activityPage = this.clampPage(this.activityPage, this.activityPageCount)
            this.refreshRows()
        })
        this.subscribeUntilDestroyed(this.scanner.scanResults$, clis => this.updateCliCards(clis))
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
                    this.askCwd(pane)
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
        this.sessionPage = this.clampPage(this.sessionPage, this.sessionPageCount)
        for (const row of rows) {
            if (row.sessionId) {
                this.sessionNames.set(row.sessionId, this.nameFor(row))
            }
        }

        const counts = new Map<AiRowState, number>()
        for (const row of rows) {
            counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
        }
        this.counters = [...counts.entries()]
            .sort((a, b) => STATE_RANK[a[0]] - STATE_RANK[b[0]])
            .map(([state, count]) => ({ state, count }))
    }

    get pagedRows (): AiSessionRow[] {
        const start = this.sessionPage * SESSION_PAGE_SIZE
        return this.rows.slice(start, start + SESSION_PAGE_SIZE)
    }

    get sessionPageCount (): number {
        return Math.max(1, Math.ceil(this.rows.length / SESSION_PAGE_SIZE))
    }

    get pagedRecent (): AiEvent[] {
        const start = this.activityPage * ACTIVITY_PAGE_SIZE
        return this.recent.slice(start, start + ACTIVITY_PAGE_SIZE)
    }

    get activityPageCount (): number {
        return Math.max(1, Math.ceil(this.recent.length / ACTIVITY_PAGE_SIZE))
    }

    get pagedCliCards (): AiCliLaunchCard[] {
        const start = Math.max(0, this.launchPage * LAUNCH_PAGE_SIZE - 1)
        const count = LAUNCH_PAGE_SIZE - (this.launchPage === 0 ? 1 : 0)
        return this.cliCards.slice(start, start + count)
    }

    get launchPageCount (): number {
        return Math.max(1, Math.ceil((this.cliCards.length + 1) / LAUNCH_PAGE_SIZE))
    }

    changeSessionPage (delta: number): void {
        this.sessionPage = this.clampPage(this.sessionPage + delta, this.sessionPageCount)
    }

    changeActivityPage (delta: number): void {
        this.activityPage = this.clampPage(this.activityPage + delta, this.activityPageCount)
    }

    changeLaunchPage (delta: number): void {
        this.launchPage = this.clampPage(this.launchPage + delta, this.launchPageCount)
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

    /**
     * User-given name first (rename the tab and it sticks), else the working
     * directory — the tab title is unusable here: claude overwrites it with
     * the prompt text, which the caption already shows.
     */
    nameFor (row: AiSessionRow): string {
        // the rail names the split container, not the pane inside it
        if (row.pane.customTitle || row.topTab.customTitle) {
            return row.pane.customTitle || row.topTab.customTitle
        }
        const configured = row.pane.profile?.options?.cwd
        return this.baseName(configured) ?? this.liveCwdNames.get(row.pane) ?? row.pane.title
    }

    rename (row: AiSessionRow, event: MouseEvent): void {
        event.stopPropagation()
        this.app.renameTab(row.pane)
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

    kindLabel (kind: AiEventKind): string {
        switch (kind) {
            case 'session-started': return this.translate.instant('session start')
            case 'prompt-submitted': return this.translate.instant('prompt sent')
            case 'tool-call': return this.translate.instant('tool call')
            case 'permission-request': return this.translate.instant('approval')
            case 'turn-completed': return this.translate.instant('turn done')
            case 'notification': return this.translate.instant('notice')
            case 'session-ended': return this.translate.instant('session end')
            case 'process-exited': return this.translate.instant('exited')
        }
    }

    /** Timeline dot colour = the state the event puts the session in */
    dotFor (event: AiEvent): string {
        return stateAfter(event.kind) ?? 'neutral'
    }

    sessionNameFor (sessionId: string): string {
        return this.sessionNames.get(sessionId) ?? sessionId.slice(0, 8)
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

    async launchCard (card: AiCliLaunchCard): Promise<void> {
        if (card.detected) {
            await this.launch(card.detected)
        }
    }

    async launchTerminal (): Promise<void> {
        const profile = await this.profilesService.showProfileSelector().catch(() => null)
        if (profile) {
            await this.profilesService.launchProfile(profile)
        }
    }

    rescan (): void {
        this.scanner.scan()
    }

    get tabsLocation (): string {
        return this.configService.store.appearance.tabsLocation
    }

    setTabsLocation (value: string): void {
        this.configService.store.appearance.tabsLocation = value
        this.configService.save()
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

    private baseName (dir: string|null|undefined): string|null {
        const name = dir?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
        return name ? name : null
    }

    private clampPage (page: number, pageCount: number): number {
        return Math.max(0, Math.min(page, pageCount - 1))
    }

    private updateCliCards (clis: DetectedCli[]): void {
        const detected = new Map(clis.map(cli => [cli.entry.id, cli]))
        this.cliCards = AI_CLI_REGISTRY
            .map(entry => ({ entry, detected: detected.get(entry.id) ?? null }))
            .sort((a, b) => Number(!!b.detected) - Number(!!a.detected))
        this.launchPage = this.clampPage(this.launchPage, this.launchPageCount)
    }

    /** One shot per pane, and only once its session exists — the answer never changes for a CLI */
    private askCwd (pane: TerminalTabComponent): void {
        if (this.cwdAsked.has(pane) || pane.profile?.options?.cwd || !pane.session) {
            return
        }
        this.cwdAsked.add(pane)
        pane.session.getWorkingDirectory().then(cwd => {
            const name = this.baseName(cwd)
            if (name) {
                this.liveCwdNames.set(pane, name)
            }
        }).catch(() => { /* unnamed is survivable */ })
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
