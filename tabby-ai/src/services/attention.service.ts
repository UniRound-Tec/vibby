import { Injectable, NgZone } from '@angular/core'
import { AppService, ConfigService, HostWindowService, TranslateService } from 'tabby-core'
import { AiEventBusService, AiAttentionPulse } from './eventBus.service'
import { AiSessionDirectoryService } from './sessionDirectory.service'
import { AiSessionNavigatorService } from './sessionNavigator.service'
import {
    activatedSessionId, AiNotificationReason, normalizeAiNotificationCliKind,
    shouldDeliverAiNotification,
} from '../notifications'
import { eventCaptionFor } from '../presentation'

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
        if (pulse.to === 'working') {
            return
        }
        // Every other state is notifiable, and the annotation makes the compiler
        // say so: a new AiSessionState would fail here rather than go unnoticed.
        const reason: AiNotificationReason = pulse.to

        const binding = this.sessions.forSession(pulse.sessionId)
        const pane = binding?.pane ?? null
        const topTab = pane ? this.navigator.topTabFor(pane) : null
        const now = Date.now()
        if (!shouldDeliverAiNotification({
            notificationsEnabled: this.config.store.aiCli.events.notifications,
            notifyOnIdle: this.config.store.aiCli.events.notifyOnIdle,
            reason,
            viewingSession: document.hasFocus() && !!topTab && this.app.activeTab === topTab,
            throttled: now - (this.lastNotified.get(pulse.sessionId) ?? 0) < THROTTLE_MS,
        })) {
            return
        }
        this.lastNotified.set(pulse.sessionId, now)

        const title = pane?.title ?? this.translate.instant('AI session')
        const caption = eventCaptionFor(pulse.event)
        const body = 'key' in caption
            ? this.translate.instant(caption.key)
            : caption.text
        console.debug(`[tabby-ai] attention notify [${pulse.sessionId.slice(0, 8)}] ${pulse.from}→${pulse.to}: ${pulse.event.summary}`)
        window.vibbyAiNotifications?.notify({
            sessionId: pulse.sessionId,
            reason,
            cliKind: normalizeAiNotificationCliKind(binding?.kind),
            title,
            body,
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
