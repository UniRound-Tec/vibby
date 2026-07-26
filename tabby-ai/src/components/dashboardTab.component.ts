import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Injector } from '@angular/core'
import { DomSanitizer, SafeHtml } from '@angular/platform-browser'
import { auditTime, interval } from 'rxjs'
import { BaseTabComponent, AppService, ConfigService, PartialProfile, ProfilesService, SplitTabComponent, TranslateService } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { AiCliRegistryEntry, DetectedCli } from '../api'
import { VIBBY_WORDMARK } from '../branding'
import { AiEvent, AiEventKind, AiSessionSnapshot, stateAfter } from '../events'
import {
    AiDisplayState, DISPLAY_STATE_RANK, SessionFacts, displayStateFor, lastEventCaptionFor, stateLabelKey,
} from '../presentation'
import { AiCliProfile } from '../profiles'
import { AI_CLI_REGISTRY } from '../registry'
import { CliScannerService } from '../services/cliScanner.service'
import { AiEventBusService } from '../services/eventBus.service'
import { ClaudeAdapterService } from '../services/claudeAdapter.service'
import { RuntimeCliDetectorService } from '../services/runtimeCliDetector.service'

export interface AiSessionRow {
    topTab: BaseTabComponent
    pane: TerminalTabComponent
    kind: string|null
    sessionId: string|null
    snapshot: AiSessionSnapshot|null
    state: AiDisplayState
    runtimeDetected: boolean
    // view-model fields, precomputed in refreshRows so the template binds
    // plain properties instead of re-running methods on every CD cycle
    icon: SafeHtml|null
    stateLabel: string
    name: string
    caption: string
    live: string
    duration: string
}

/** Timeline entry with its display strings resolved once, not per CD cycle */
export interface AiEventRow {
    event: AiEvent
    time: string
    dot: string
    who: string
    kindLabel: string
}

export interface AiCliLaunchCard {
    entry: AiCliRegistryEntry
    detected: DetectedCli|null
    icon: SafeHtml|null
}

/** Rows shown in the activity timeline — the bus keeps more than anyone wants to read */
const TIMELINE_LENGTH = 20
const SESSION_PAGE_SIZE = 6
const ACTIVITY_PAGE_SIZE = 6
const LAUNCH_PAGE_SIZE = 8

/** @hidden */
@Component({
    selector: 'ai-dashboard-tab',
    templateUrl: './dashboardTab.component.pug',
    styleUrls: ['./dashboardTab.component.scss'],
    // all state changes flow through this component's own subscriptions,
    // which call markForCheck — app-wide CD cycles don't need to re-check it
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardTabComponent extends BaseTabComponent {
    /** Renders the tab header as a compact icon-only tab (tabHeader.component.ts hook) */
    miniHeader = true

    rows: AiSessionRow[] = []
    counters: { state: AiDisplayState, count: number, label: string }[] = []
    recent: AiEvent[] = []
    eventRows: AiEventRow[] = []
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

    cliCards: AiCliLaunchCard[] = AI_CLI_REGISTRY.map(entry => ({ entry, detected: null, icon: null }))
    scanning = false
    now = Date.now()
    readonly wordmark = VIBBY_WORDMARK
    readonly terminalIcon: SafeHtml

    private snapshots: ReadonlyMap<string, AiSessionSnapshot> = new Map()
    // weak: these are keyed by components that outlive nothing, and the
    // dashboard is a long-lived tab — a strong reference here would pin every
    // split and terminal the user has ever closed
    private watchedSplits = new WeakSet<SplitTabComponent>()
    private iconCache = new Map<string, SafeHtml>()
    /** Only for panes whose profile carries no cwd — asked once per pane, never per render */
    private liveCwdNames = new WeakMap<TerminalTabComponent, string>()
    private cwdAsked = new WeakSet<TerminalTabComponent>()
    /** Outlives the rows: the timeline still names sessions whose tab is long gone */
    private sessionNames = new Map<string, string>()
    /** Labels come from a small fixed key set — skip ngx-translate interpolation per row per refresh */
    private labelCache = new Map<string, string>()

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
        private runtimeDetector: RuntimeCliDetectorService,
        private cdr: ChangeDetectorRef,
    ) {
        super(injector)
        this.terminalIcon = sanitizer.bypassSecurityTrustHtml(require('../icons/terminal.svg'))
        this.cliCards = this.cliCards.map(card => ({ ...card, icon: this.iconForKind(card.entry.id) }))
        this.setTitle(translate.instant('Home'))
        this.subscribeUntilDestroyed(this.translate.onLangChange, () => {
            this.labelCache.clear()
            this.refreshRows()
        })
        this.subscribeUntilDestroyed(this.app.tabsChanged$, () => this.refreshRows())
        // live-status scrapes tick sub-second while a session is working;
        // reading speed is all the dashboard needs to keep up with
        this.subscribeUntilDestroyed(this.bus.snapshots$.pipe(auditTime(250)), snapshots => {
            this.snapshots = snapshots
            this.recent = this.bus.recentEvents.slice(0, TIMELINE_LENGTH)
            this.activityPage = this.clampPage(this.activityPage, this.activityPageCount)
            this.refreshRows()
        })
        this.subscribeUntilDestroyed(this.scanner.scanResults$, clis => this.updateCliCards(clis))
        this.subscribeUntilDestroyed(this.scanner.scanning$, scanning => {
            this.scanning = scanning
            this.cdr.markForCheck()
        })
        this.subscribeUntilDestroyed(this.runtimeDetector.changed$, () => this.refreshRows())
        this.subscribeUntilDestroyed(this.configService.changed$, () => this.applyThemeVars())
        // `now` only feeds the duration column — no point waking change
        // detection for it while the dashboard isn't even on screen
        this.subscribeUntilDestroyed(interval(5000), () => {
            if (this.hasFocus && !document.hidden) {
                this.updateDurations()
            }
        })
        this.subscribeUntilDestroyed(this.focused$, () => this.updateDurations())
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
                const kind = pane instanceof TerminalTabComponent ? this.runtimeDetector.kindForPane(pane) : null
                if (pane instanceof TerminalTabComponent && kind) {
                    this.askCwd(pane)
                    const sessionId = this.adapter.sessionIdForPane(pane, kind)
                    const snapshot = sessionId ? this.snapshots.get(sessionId) ?? null : null
                    const row: AiSessionRow = {
                        topTab,
                        pane,
                        kind,
                        sessionId,
                        snapshot,
                        state: displayStateFor({ snapshot, sessionId, runtimeDetected: false }),
                        runtimeDetected: this.runtimeDetector.isRuntimeDetected(pane) && !sessionId,
                        icon: this.iconForKind(kind),
                        stateLabel: '',
                        name: '',
                        caption: '',
                        live: snapshot?.liveStatus ?? '',
                        duration: '',
                    }
                    row.stateLabel = this.label(stateLabelKey(row.state))
                    row.name = this.nameFor(row)
                    row.caption = this.captionFor(row)
                    row.duration = this.durationFor(row)
                    rows.push(row)
                }
            }
        }
        rows.sort((a, b) => DISPLAY_STATE_RANK[a.state] - DISPLAY_STATE_RANK[b.state])
        this.rows = rows
        this.sessionPage = this.clampPage(this.sessionPage, this.sessionPageCount)
        for (const row of rows) {
            if (row.sessionId) {
                this.sessionNames.set(row.sessionId, row.name)
            }
        }

        // resolved after sessionNames so the timeline can name every session
        this.eventRows = this.recent.map(event => ({
            event,
            time: this.feedTime(event),
            dot: this.dotFor(event),
            who: this.sessionNameFor(event.sessionId),
            kindLabel: this.kindLabel(event.kind),
        }))

        const counts = new Map<AiDisplayState, number>()
        for (const row of rows) {
            counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
        }
        this.counters = [...counts.entries()]
            .sort((a, b) => DISPLAY_STATE_RANK[a[0]] - DISPLAY_STATE_RANK[b[0]])
            .map(([state, count]) => ({ state, count, label: this.label(stateLabelKey(state)) }))
        this.cdr.markForCheck()
    }

    /** Recomputes only the duration column — the rest of the row is event-driven */
    private updateDurations (): void {
        this.now = Date.now()
        for (const row of this.rows) {
            row.duration = this.durationFor(row)
        }
        this.cdr.markForCheck()
    }

    get pagedRows (): AiSessionRow[] {
        const start = this.sessionPage * SESSION_PAGE_SIZE
        return this.rows.slice(start, start + SESSION_PAGE_SIZE)
    }

    get sessionPageCount (): number {
        return Math.max(1, Math.ceil(this.rows.length / SESSION_PAGE_SIZE))
    }

    get pagedRecent (): AiEventRow[] {
        const start = this.activityPage * ACTIVITY_PAGE_SIZE
        return this.eventRows.slice(start, start + ACTIVITY_PAGE_SIZE)
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

    get detectedCliCount (): number {
        return this.cliCards.filter(card => !!card.detected).length
    }

    get monitoredSessionCount (): number {
        return this.rows.filter(row => !!row.sessionId).length
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

    stateLabel (state: AiDisplayState): string {
        return this.label(stateLabelKey(state))
    }

    /** trackBy hooks — arrows because ngFor calls them without a `this` */
    trackRow = (_index: number, row: AiSessionRow): unknown => row.pane

    trackEventRow = (_index: number, row: AiEventRow): string =>
        `${row.event.ts}:${row.event.sessionId}:${row.event.kind}`

    trackCard = (_index: number, card: AiCliLaunchCard): string => card.entry.id

    trackCounter = (_index: number, counter: { state: AiDisplayState }): string => counter.state

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
        const caption = lastEventCaptionFor(row as SessionFacts)
        return 'key' in caption ? this.label(caption.key) : caption.text
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
            case 'session-started': return this.label('session start')
            case 'prompt-submitted': return this.label('prompt sent')
            case 'tool-call': return this.label('tool call')
            case 'permission-request': return this.label('approval')
            case 'turn-completed': return this.label('turn done')
            case 'notification': return this.label('notice')
            case 'session-ended': return this.label('session end')
            case 'process-exited': return this.label('exited')
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

    async launchCard (card: AiCliLaunchCard): Promise<void> {
        if (card.detected) {
            const profile = await this.profileFor(card.detected)
            if (profile) {
                await this.profilesService.launchProfile(profile)
            }
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

    private label (key: string): string {
        let value = this.labelCache.get(key)
        if (value === undefined) {
            value = this.translate.instant(key)
            this.labelCache.set(key, value!)
        }
        return value!
    }

    private baseName (dir: string|null|undefined): string|null {
        const name = dir?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
        return name ? name : null
    }

    private clampPage (page: number, pageCount: number): number {
        return Math.max(0, Math.min(page, pageCount - 1))
    }

    private async profileFor (cli: DetectedCli): Promise<PartialProfile<AiCliProfile>|undefined> {
        const profiles = await this.profilesService.getProfiles()
        return profiles.find(x => x.id === `ai-cli:${cli.entry.id}`) as PartialProfile<AiCliProfile>|undefined
    }

    private updateCliCards (clis: DetectedCli[]): void {
        const detected = new Map(clis.map(cli => [cli.entry.id, cli]))
        this.cliCards = AI_CLI_REGISTRY
            .map(entry => ({ entry, detected: detected.get(entry.id) ?? null, icon: this.iconForKind(entry.id) }))
            .sort((a, b) => Number(!!b.detected) - Number(!!a.detected))
        this.launchPage = this.clampPage(this.launchPage, this.launchPageCount)
        this.cdr.markForCheck()
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
                // row.name is precomputed now — fold the late answer in
                this.refreshRows()
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
