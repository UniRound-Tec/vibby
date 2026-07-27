import { Injectable, NgZone } from '@angular/core'
import { AppService, ConfigService, HostWindowService, TranslateService } from 'tabby-core'
import { AiEventBusService, AiAttentionPulse } from './eventBus.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { AiSessionNavigatorService } from './sessionNavigator.service'
import { activatedSessionId, AiNotificationReason } from '../notifications'

/** needs-you can flap (permission bursts) — don't spam per session */
const THROTTLE_MS = 5000

/**
 * Attention pulse consumer for M2: desktop notifications (docs/06-m2-plan.md §4).
 * Decides *whether* to notify; the main process owns *how* on each platform
 * (app/lib/notifications.ts).
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
        private sessions: AiSessionDirectoryService,
        private navigator: AiSessionNavigatorService,
        private translate: TranslateService,
        private zone: NgZone,
    ) { }

    activate (): void {
        this.bus.attention$.subscribe(pulse => this.onPulse(pulse))
        // otherwise this keeps one entry per session the app has ever seen
        this.bus.sessionDropped$.subscribe(sessionId => this.lastNotified.delete(sessionId))

        window.vibbyAiNotifications?.onActivated((value: unknown) => {
            const sessionId = activatedSessionId(value)
            if (sessionId) {
                this.zone.run(() => this.focusSession(sessionId))
            }
        })
    }

    private onPulse (pulse: AiAttentionPulse): void {
        const events = this.config.store.aiCli.events
        if (!events.notifications) {
            return
        }
        if (pulse.to === 'idle' && !events.notifyOnIdle) {
            return
        }
        if (pulse.to === 'working') {
            return
        }
        // Every other state is notifiable, and the annotation makes the compiler
        // say so: a new AiSessionState would fail here rather than go unnoticed.
        const reason: AiNotificationReason = pulse.to

        const pane = this.sessions.forSession(pulse.sessionId)?.pane ?? null
        const topTab = pane ? this.navigator.topTabFor(pane) : null

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
        window.vibbyAiNotifications?.notify({
            sessionId: pulse.sessionId,
            reason,
            title,
            body: pulse.event.summary,
        })
    }

    /** Clicking a toast lands here, by way of the main process. */
    private focusSession (sessionId: string): void {
        this.hostWindow.bringToFront()
        const pane = this.sessions.forSession(sessionId)?.pane
        if (pane) {
            this.navigator.focusPane(pane)
        }
    }
}
