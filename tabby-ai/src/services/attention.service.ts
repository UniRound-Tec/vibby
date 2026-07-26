import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, HostWindowService, SplitTabComponent, TranslateService } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { AiEventBusService, AiAttentionPulse } from './eventBus.service'
import { ClaudeAdapterService } from './claudeAdapter.service'

/** needs-you can flap (permission bursts) — don't spam per session */
const THROTTLE_MS = 5000

/**
 * Attention pulse consumer for M2: desktop notifications (docs/06-m2-plan.md §4).
 * M3 will attach the hardware blink to the same attention$ stream.
 */
@Injectable({ providedIn: 'root' })
export class AiAttentionService {
    private lastNotified = new Map<string, number>()

    constructor (
        private app: AppService,
        private config: ConfigService,
        private hostWindow: HostWindowService,
        private bus: AiEventBusService,
        private adapter: ClaudeAdapterService,
        private translate: TranslateService,
        private zone: NgZone,
    ) { }

    activate (): void {
        this.bus.attention$.subscribe(pulse => this.onPulse(pulse))
        // otherwise this keeps one entry per session the app has ever seen
        this.bus.sessionDropped$.subscribe(sessionId => this.lastNotified.delete(sessionId))
    }

    private onPulse (pulse: AiAttentionPulse): void {
        const events = this.config.store.aiCli.events
        if (!events.notifications) {
            return
        }
        if (pulse.to === 'idle' && !events.notifyOnIdle) {
            return
        }
        if (pulse.to !== 'needs-you' && pulse.to !== 'error' && pulse.to !== 'idle') {
            return
        }

        const pane = this.adapter.paneForSessionId(pulse.sessionId)
        const topTab = pane ? this.topTabFor(pane) : null

        // don't self-interrupt: the user is already looking at this session
        if (document.hasFocus() && topTab && this.app.activeTab === topTab) {
            return
        }

        const now = Date.now()
        if (now - (this.lastNotified.get(pulse.sessionId) ?? 0) < THROTTLE_MS) {
            return
        }
        this.lastNotified.set(pulse.sessionId, now)

        const title = pane?.title ?? this.translate.instant('AI session')
        console.debug(`[tabby-ai] attention notify [${pulse.sessionId.slice(0, 8)}] ${pulse.from}→${pulse.to}: ${pulse.event.summary}`)
        const notification = new Notification(title, {
            body: pulse.event.summary,
            silent: pulse.to === 'idle',
        })
        notification.onclick = () => this.zone.run(() => {
            this.hostWindow.bringToFront()
            if (pane && topTab) {
                this.app.selectTab(topTab)
                if (topTab instanceof SplitTabComponent) {
                    topTab.focus(pane)
                }
            }
        })
    }

    private topTabFor (pane: TerminalTabComponent): BaseTabComponent | null {
        return this.app.tabs.find(t =>
            t === pane || t instanceof SplitTabComponent && t.getAllTabs().includes(pane),
        ) ?? null
    }
}
