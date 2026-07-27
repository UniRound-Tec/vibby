import { app, ipcMain, nativeImage, NativeImage, Notification, WebContents } from 'electron'

import {
    AI_NOTIFICATION_CHANNELS,
    AiNotificationPlatform,
    AiNotificationRequest,
    normalizeAiNotificationRequest,
    notificationPresentation,
} from '../../tabby-ai/src/notifications'
import type { Window } from './window'

/**
 * The tray glyph, not the 1024px logo: it carries its own dark background, so it
 * stays legible on a notification surface of any colour. Linux daemons show
 * nothing without an icon, and Windows falls back to the shortcut's icon.
 */
let cachedIcon: NativeImage | null = null

function icon (): NativeImage {
    cachedIcon ??= nativeImage.createFromPath(`${app.getAppPath()}/assets/tray.png`)
    return cachedIcon
}

/** Anything that is not Windows or macOS notifies through libnotify. */
function platform (): AiNotificationPlatform {
    if (process.platform === 'win32' || process.platform === 'darwin') {
        return process.platform
    }
    return 'linux'
}

/**
 * Shows OS notifications on behalf of the renderer, which decides *whether* to
 * notify (see AiAttentionService) while this owns *how* on each platform.
 */
export class AiNotificationHub {
    /** At most one live toast per session, so a long run cannot pile up. */
    private live = new Map<string, Notification>()
    private warnedUnsupported = false

    constructor (
        private findWindowBySender: (sender: WebContents) => Window | null,
    ) {
        ipcMain.on(AI_NOTIFICATION_CHANNELS.notify, (event, value: unknown) => {
            const request = normalizeAiNotificationRequest(value)
            if (!request) {
                return
            }
            // the sender is the authority on which window owns the session, so
            // nothing about the target is taken from the payload
            const target = this.findWindowBySender(event.sender)
            if (target) {
                this.show(request, target)
            }
        })
    }

    /** Drops every toast belonging to a window that is going away. */
    forgetWindow (windowId: number): void {
        for (const [key, notification] of this.live) {
            if (key.startsWith(`${windowId}:`)) {
                notification.close()
                this.live.delete(key)
            }
        }
    }

    destroy (): void {
        for (const notification of this.live.values()) {
            notification.close()
        }
        this.live.clear()
    }

    private show (request: AiNotificationRequest, target: Window): void {
        if (!Notification.isSupported()) {
            if (!this.warnedUnsupported) {
                this.warnedUnsupported = true
                console.warn('[vibby] the OS reports no notification support; attention notifications are disabled')
            }
            return
        }

        const presentation = notificationPresentation(request.reason, platform())
        const notification = new Notification({
            title: request.title,
            body: request.body,
            icon: icon(),
            silent: presentation.silent,
            urgency: presentation.urgency,
            timeoutType: presentation.timeoutType,
        })

        // keyed per window: two windows can hold sessions with the same id
        const key = `${target.id}:${request.sessionId}`
        this.live.get(key)?.close()
        this.live.set(key, notification)
        const forget = () => {
            if (this.live.get(key) === notification) {
                this.live.delete(key)
            }
        }
        notification.on('close', forget)
        notification.on('failed', error => {
            forget()
            console.warn('[vibby] notification failed to display:', error)
        })

        notification.on('click', () => {
            if (target.isDestroyed()) {
                return
            }
            void target.restoreAndPresent()
            // the renderer owns pane focus, so hand the session back to it
            target.send(AI_NOTIFICATION_CHANNELS.activated, { sessionId: request.sessionId })
        })

        if (presentation.bounceDock) {
            // macOS only; the dock keeps bouncing until the app is focused
            app.dock?.bounce('informational')
        }

        notification.show()
    }
}
