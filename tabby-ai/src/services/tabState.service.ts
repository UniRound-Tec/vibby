import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent, TranslateService } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { AiSessionSnapshot, AiSessionState } from '../events'
import { AI_CLI_REGISTRY } from '../registry'
import { AiEventBusService } from './eventBus.service'
import { ClaudeAdapterService } from './claudeAdapter.service'
import { RuntimeCliChange, RuntimeCliDetectorService } from './runtimeCliDetector.service'

/** Worst-first, same order the dashboard sorts by: a split shows its loudest pane */
const SEVERITY: Record<AiSessionState, number> = {
    'needs-you': 0,
    working: 1,
    idle: 2,
    error: 3,
}

/**
 * Publishes what the side rail needs onto each tab object: which group it
 * belongs to, its AI kind, state, and last action. Plain properties, because
 * that is all tabHeader's markup hook reads — no bindings, no subscriptions
 * and no vibby imports inside core.
 */
@Injectable({ providedIn: 'root' })
export class AiTabStateService {
    private watchedSplits = new WeakSet<SplitTabComponent>()

    constructor (
        private app: AppService,
        private bus: AiEventBusService,
        private adapter: ClaudeAdapterService,
        private runtimeDetector: RuntimeCliDetectorService,
        private translate: TranslateService,
    ) { }

    activate (): void {
        this.bus.snapshots$.subscribe(() => this.refresh())
        this.app.tabsChanged$.subscribe(() => this.refresh())
        this.runtimeDetector.changed$.subscribe(change => this.onRuntimeChange(change))
        // the split wrapper's child is attached right after the tab is added,
        // so the AI check has to wait for the current frame to finish
        this.app.tabOpened$.subscribe(tab => setTimeout(() => this.groupTab(tab)))
    }

    /**
     * Keeps AI sessions together at the top. Only on open — after that the
     * order is the user's, and dragging must not be second-guessed.
     */
    private groupTab (tab: BaseTabComponent): void {
        if (!this.app.tabs.includes(tab) || !this.aiPaneOf(tab)) {
            return
        }
        // the end of the *leading run* of AI tabs, not the total count: on
        // session restore every tab reports in, and counting the whole list
        // would make each one leapfrog the others
        const others = this.app.tabs.filter(other => other !== tab)
        let target = 0
        while (target < others.length && (others[target]['miniHeader'] || !!this.aiPaneOf(others[target]))) {
            target++
        }
        // moveTabToIndex splices after removing, so `target` is the slot to land in
        if (this.app.tabs.indexOf(tab) > target) {
            this.app.moveTabToIndex(tab, target)
        }
    }

    private refresh (): void {
        let previousGroup: string | null = null
        for (const tab of this.app.tabs) {
            this.watchSplit(tab)
            // the dashboard is not in the side rail's list, so it must not
            // take part in grouping either — it would eat a heading
            if (tab['miniHeader']) {
                tab['aiGroup'] = null
                continue
            }
            const aiPanes = this.aiPanesOf(tab)
            const aiPane = aiPanes[0] ?? null
            const group = aiPane
                ? this.translate.instant('AI sessions')
                : this.translate.instant('Terminals')
            // label only where the group changes, so an interleaved tab order
            // still reads correctly instead of lying about what follows
            tab['aiGroup'] = group === previousGroup ? null : group
            previousGroup = group

            const kind = aiPane ? this.runtimeDetector.kindForPane(aiPane) : null
            tab['aiKind'] = kind
            // the icon replaces the kind's name in the rail; the name stays as its tooltip
            tab['aiIcon'] = AI_CLI_REGISTRY.find(x => x.id === kind)?.icon ?? null
            tab['aiPaneCount'] = aiPanes.length > 1 ? aiPanes.length : null
            tab['aiPanes'] = aiPanes.length > 1
                ? aiPanes.map((pane, index) => this.paneCard(pane, index))
                : null
            this.linkSinglePaneName(tab, aiPanes)
            if (aiPane?.profile.type === 'ai-cli') {
                this.nameFromCwd(tab, aiPane)
            }

            const snapshot = this.loudestSnapshot(tab)
            if (!aiPane) {
                tab['aiState'] = null
                tab['aiStateLabel'] = null
                tab['aiSummary'] = null
                continue
            }
            const monitoringSessionId = this.adapter.sessionIdForPane(aiPane, kind)
            // an AI tab is a card even before its first event — a session that
            // never reports is exactly what the rail has to make visible
            tab['aiState'] = snapshot?.state ?? (monitoringSessionId ? 'listening' : 'untracked')
            tab['aiStateLabel'] = snapshot
                ? this.stateLabel(snapshot.state)
                : monitoringSessionId
                    ? this.translate.instant('Listening')
                    : this.translate.instant('Untracked')
            // the scraped status line is fresher than the last hook event
            tab['aiSummary'] = snapshot
                ? snapshot.liveStatus ?? snapshot.lastEvent?.summary ?? null
                : this.runtimeDetector.isRuntimeDetected(aiPane) && !monitoringSessionId
                    ? this.translate.instant('Detected in terminal · event monitoring unavailable')
                    : monitoringSessionId
                        ? this.translate.instant('Event monitoring enabled · waiting for CLI activity')
                        : this.translate.instant('Launch only · no event monitoring yet')
        }
    }

    private stateLabel (state: AiSessionState): string {
        switch (state) {
            case 'needs-you': return this.translate.instant('Needs you')
            case 'working': return this.translate.instant('Working')
            case 'idle': return this.translate.instant('Idle')
            case 'error': return this.translate.instant('Error')
        }
    }

    /** Every AI pane in the tab — split panes remain individually observable. */
    private aiPanesOf (tab: BaseTabComponent): TerminalTabComponent[] {
        const panes = tab instanceof SplitTabComponent ? tab.getAllTabs() : [tab]
        const result: TerminalTabComponent[] = []
        for (const pane of panes) {
            if (pane instanceof TerminalTabComponent && this.runtimeDetector.kindForPane(pane)) {
                result.push(pane)
            }
        }
        return result
    }

    /** First AI pane in the tab, or null if this is an ordinary terminal. */
    private aiPaneOf (tab: BaseTabComponent): TerminalTabComponent | null {
        return this.aiPanesOf(tab)[0] ?? null
    }

    private paneCard (pane: TerminalTabComponent, index: number): Record<string, unknown> {
        const kind = this.runtimeDetector.kindForPane(pane)
        const sessionId = this.adapter.sessionIdForPane(pane, kind)
        const snapshot = sessionId ? this.bus.snapshotFor(sessionId) : null
        const launchName = pane.profile?.options?.['aiCli']?.sessionName?.trim()
        const name = pane.customTitle ||
            launchName ||
            this.baseName(pane.profile?.options?.cwd) ||
            pane.profile?.name ||
            pane.title

        return {
            pane,
            index: index + 1,
            name,
            icon: AI_CLI_REGISTRY.find(x => x.id === kind)?.icon ?? null,
            kind,
            state: snapshot?.state ?? (sessionId ? 'listening' : 'untracked'),
            stateLabel: snapshot
                ? this.stateLabel(snapshot.state)
                : sessionId
                    ? this.translate.instant('Listening')
                    : this.translate.instant('Untracked'),
            summary: snapshot
                ? snapshot.liveStatus ?? snapshot.lastEvent?.summary ?? null
                : this.runtimeDetector.isRuntimeDetected(pane) && !sessionId
                    ? this.translate.instant('Detected in terminal · event monitoring unavailable')
                    : sessionId
                        ? this.translate.instant('Event monitoring enabled · waiting for CLI activity')
                        : this.translate.instant('Launch only · no event monitoring yet'),
        }
    }

    /**
     * A one-pane SplitTab is an implementation detail, not a user-visible
     * group. Keep its wrapper and pane title linked so renaming from either
     * the rail or dashboard cannot create two conflicting names.
     *
     * Once there are multiple panes the wrapper becomes the group name and
     * each pane keeps its own independent name.
     */
    private linkSinglePaneName (tab: BaseTabComponent, aiPanes: TerminalTabComponent[]): void {
        const oldPeer = tab['linkedRenameTab'] as BaseTabComponent | null
        if (oldPeer?.['linkedRenameTab'] === tab) {
            oldPeer['linkedRenameTab'] = null
        }
        tab['linkedRenameTab'] = null

        if (aiPanes.length !== 1 || tab === aiPanes[0]) {
            return
        }

        const pane = aiPanes[0]
        const paneHasUserName = !!pane.customTitle && pane.customTitle !== pane['aiAutoName']
        const tabHasUserName = this.userNamed(tab)

        // Older builds could rename these independently. The pane is the
        // actual session, so its explicit name wins during one-time repair.
        if (paneHasUserName && pane.customTitle !== tab.customTitle) {
            tab.setTitle(pane.customTitle)
            tab.customTitle = pane.customTitle
            tab['aiAutoName'] = null
        } else if (tabHasUserName && tab.customTitle !== pane.customTitle) {
            pane.setTitle(tab.customTitle)
            pane.customTitle = tab.customTitle
            pane['aiAutoName'] = null
        }

        tab['linkedRenameTab'] = pane
        pane['linkedRenameTab'] = tab
    }

    private watchSplit (tab: BaseTabComponent): void {
        if (!(tab instanceof SplitTabComponent) || this.watchedSplits.has(tab)) {
            return
        }
        this.watchedSplits.add(tab)
        tab.tabAdded$.subscribe(() => this.refresh())
        tab.tabRemoved$.subscribe(() => this.refresh())
        tab.focusChanged$.subscribe(() => this.refresh())
    }

    private onRuntimeChange (change: RuntimeCliChange): void {
        if (change.kind) {
            const topTab = this.app.tabs.find(tab =>
                tab === change.pane ||
                tab instanceof SplitTabComponent && tab.getAllTabs().includes(change.pane),
            )
            if (topTab) {
                this.groupTab(topTab)
            }
        }
        this.refresh()
    }

    private loudestSnapshot (tab: BaseTabComponent): AiSessionSnapshot | null {
        const panes = tab instanceof SplitTabComponent ? tab.getAllTabs() : [tab]
        let loudest: AiSessionSnapshot | null = null
        for (const pane of panes) {
            const sessionId = this.adapter.sessionIdForPane(
                pane,
                pane instanceof TerminalTabComponent ? this.runtimeDetector.kindForPane(pane) : null,
            )
            const snapshot = sessionId ? this.bus.snapshotFor(sessionId) : null
            if (snapshot && (!loudest || SEVERITY[snapshot.state] < SEVERITY[loudest.state])) {
                loudest = snapshot
            }
        }
        return loudest
    }

    /**
     * Name AI tabs after their working directory once, unless the user has
     * named them. claude rewrites the terminal title with the prompt text on
     * every turn, which makes the rail unreadable; setting customTitle both
     * fixes the label and stops tabby taking further title updates.
     */
    /**
     * The name goes on `tab`, not on `pane`: tabby wraps every tab in a
     * SplitTabComponent, and that container is what the tab header renders.
     */
    private nameFromCwd (tab: BaseTabComponent, pane: TerminalTabComponent): void {
        if (this.userNamed(tab)) {
            return
        }
        const launchName = pane.profile?.options?.['aiCli']?.sessionName?.trim()
        if (launchName) {
            this.autoName(tab, launchName)
            return
        }
        const configured = this.baseName(pane.profile?.options?.cwd)
        if (configured) {
            this.autoName(tab, configured)
            return
        }
        if (pane.session && !pane['aiCwdPending']) {
            pane['aiCwdPending'] = true
            pane.session.getWorkingDirectory().then(cwd => {
                pane['aiCwdPending'] = false
                this.autoName(tab, this.baseName(cwd))
            }).catch(() => { pane['aiCwdPending'] = false })
        }
        // never leave the rail showing the raw terminal title: claude writes
        // its own OSC title and tabby prefixes it, which reads as noise
        if (!tab.customTitle) {
            this.autoName(tab, pane.profile?.name ?? null)
        }
    }

    /** True once the human has renamed the tab — their name outranks every guess */
    private userNamed (tab: BaseTabComponent): boolean {
        return !!tab.customTitle && tab.customTitle !== tab['aiAutoName']
    }

    private autoName (tab: BaseTabComponent, name: string|null): void {
        if (!name || this.userNamed(tab)) {
            return
        }
        for (const target of [tab, tab['linkedRenameTab'] as BaseTabComponent | null]) {
            if (target) {
                target['aiAutoName'] = name
                target.customTitle = name
            }
        }
    }

    private baseName (dir: string|null|undefined): string|null {
        const name = dir?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
        return name ? name : null
    }
}
