import { Inject, Injectable } from '@angular/core'
import { auditTime } from 'rxjs'
import {
    AppService,
    BaseTabComponent,
    BOOTSTRAP_DATA,
    BootstrapData,
    ConfigService,
    PlatformService,
    SplitTabComponent,
    TranslateService,
} from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import {
    FloatingSessionSnapshot,
    FloatingWindowColorScheme,
} from '../floatingSessions'
import {
    activityLabelKey,
    captionFor,
    displayStateFor,
    SessionFacts,
} from '../presentation'
import { RuntimeCliDetectorService } from './runtimeCliDetector.service'
import { AiEventBusService } from './eventBus.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { AiSessionNavigatorService } from './sessionNavigator.service'

const PUBLISH_AUDIT_MS = 75

@Injectable({ providedIn: 'root' })
export class FloatingSessionPublisherService {
    private watchedPanes = new WeakSet<TerminalTabComponent>()
    private floatingIds = new WeakMap<TerminalTabComponent, string>()
    private createdAt = new Map<string, number>()
    private panesByFloatingId = new Map<string, TerminalTabComponent>()
    private nextFloatingId = 0
    private activated = false

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private translate: TranslateService,
        private runtimeDetector: RuntimeCliDetectorService,
        private bus: AiEventBusService,
        private sessions: AiSessionDirectoryService,
        private navigator: AiSessionNavigatorService,
        @Inject(BOOTSTRAP_DATA) private bootstrapData: BootstrapData,
    ) { }

    activate (): void {
        if (this.activated) {
            return
        }
        this.activated = true

        this.config.ready$.subscribe(() => this.publish())
        this.config.changed$.subscribe(() => this.publish())
        this.platform.themeChanged$.subscribe(() => this.publish())
        this.translate.onLangChange.subscribe(() => this.publish())
        this.bus.snapshots$.pipe(auditTime(PUBLISH_AUDIT_MS)).subscribe(() => this.publish())
        this.app.tabsChanged$.pipe(auditTime(PUBLISH_AUDIT_MS)).subscribe(() => this.publish())
        this.runtimeDetector.changed$.pipe(auditTime(PUBLISH_AUDIT_MS)).subscribe(() => this.publish())
        this.sessions.changed$.pipe(auditTime(PUBLISH_AUDIT_MS)).subscribe(() => this.publish())

        window.vibbyFloatingSessionSource?.onFocus((value: unknown) => {
            const sessionId = this.focusSessionId(value)
            if (!sessionId) {
                return
            }
            const pane = this.panesByFloatingId.get(sessionId)
            if (pane) {
                this.navigator.focusPane(pane)
            } else {
                this.navigator.focus(sessionId)
            }
        })

        window.addEventListener('beforeunload', () => {
            window.vibbyFloatingSessionSource?.removeSource(this.bootstrapData.windowID)
        })
    }

    private publish (): void {
        const bridge = window.vibbyFloatingSessionSource
        if (!this.config.store || !bridge) {
            return
        }
        const sessions = this.projectSessions()
        bridge.replaceSource({
            sourceWindowId: this.bootstrapData.windowID,
            enabled: !!this.config.store.aiCli.floatingWindow.enabled,
            colorScheme: this.colorScheme(),
            sessions,
        })
    }

    private projectSessions (): FloatingSessionSnapshot[] {
        const result: FloatingSessionSnapshot[] = []
        const liveIds = new Set<string>()
        this.panesByFloatingId.clear()

        for (const topTab of this.app.tabs) {
            for (const pane of this.panesOf(topTab)) {
                if (!(pane instanceof TerminalTabComponent)) {
                    continue
                }
                const kind = this.runtimeDetector.kindForPane(pane)
                if (!kind) {
                    continue
                }
                this.watchPane(pane)
                const binding = this.sessions.forPane(pane, kind)
                const sessionId = binding?.sessionId ?? this.floatingIdFor(pane)
                const eventSnapshot = binding ? this.bus.snapshotFor(binding.sessionId) : null
                const facts: SessionFacts = {
                    snapshot: eventSnapshot,
                    sessionId: binding?.sessionId ?? null,
                    runtimeDetected: this.runtimeDetector.isRuntimeDetected(pane),
                }
                const createdAt = this.createdAt.get(sessionId) ?? eventSnapshot?.lastEvent?.ts ?? Date.now()
                this.createdAt.set(sessionId, createdAt)
                liveIds.add(sessionId)
                this.panesByFloatingId.set(sessionId, pane)

                const caption = captionFor(facts)
                let summary: string|null = null
                if ('key' in caption) {
                    summary = this.translate.instant(caption.key)
                } else if (caption.text) {
                    summary = caption.text
                }
                result.push({
                    sessionId,
                    sourceWindowId: this.bootstrapData.windowID,
                    kind,
                    name: this.nameFor(pane),
                    state: displayStateFor(facts),
                    stateLabel: this.translate.instant(activityLabelKey(facts)),
                    summary,
                    createdAt,
                    lastActivityAt: eventSnapshot?.lastEvent?.ts ?? createdAt,
                })
            }
        }

        for (const sessionId of this.createdAt.keys()) {
            if (!liveIds.has(sessionId)) {
                this.createdAt.delete(sessionId)
            }
        }
        return result
    }

    private panesOf (tab: BaseTabComponent): BaseTabComponent[] {
        return tab instanceof SplitTabComponent ? tab.getAllTabs() : [tab]
    }

    private floatingIdFor (pane: TerminalTabComponent): string {
        let sessionId = this.floatingIds.get(pane)
        if (!sessionId) {
            this.nextFloatingId++
            sessionId = `pane:${this.bootstrapData.windowID}:${this.nextFloatingId}`
            this.floatingIds.set(pane, sessionId)
        }
        return sessionId
    }

    private watchPane (pane: TerminalTabComponent): void {
        if (this.watchedPanes.has(pane)) {
            return
        }
        this.watchedPanes.add(pane)
        pane.titleChange$.pipe(auditTime(PUBLISH_AUDIT_MS)).subscribe(() => this.publish())
        pane.destroyed$.subscribe(() => this.publish())
    }

    private nameFor (pane: TerminalTabComponent): string {
        const launchName = pane.profile?.options?.['aiCli']?.sessionName?.trim()
        const cwd = pane.profile?.options?.cwd
        return pane.customTitle ||
            launchName ||
            this.baseName(cwd) ||
            pane.profile?.name ||
            pane.title ||
            this.translate.instant('AI session')
    }

    private baseName (dir: string|null|undefined): string|null {
        const name = dir?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
        return name?.length ? name : null
    }

    private colorScheme (): FloatingWindowColorScheme {
        const mode = this.config.store.appearance.colorSchemeMode
        if (mode === 'light' || mode === 'dark') {
            return mode
        }
        return this.platform.getTheme()
    }

    private focusSessionId (value: unknown): string|null {
        if (!value || typeof value !== 'object') {
            return null
        }
        const sessionId = (value as { sessionId?: unknown }).sessionId
        return typeof sessionId === 'string' && sessionId.length <= 128
            ? sessionId
            : null
    }
}
