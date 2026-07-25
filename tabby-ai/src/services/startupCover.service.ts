import { Injectable } from '@angular/core'
import { AppService } from 'tabby-core'

export const STARTUP_COVER_CLASS = 'vibby-awaiting-startup-route'

/**
 * Prevents Tabby's stock StartPage from flashing while the renderer tells the
 * main process it is ready and waits for the initial CLI event to come back.
 * The cover ends as soon as any real tab opens. A short post-handshake fallback
 * preserves the stock empty page when both dashboard and terminal auto-open
 * have deliberately been disabled.
 */
@Injectable({ providedIn: 'root' })
export class StartupCoverService {
    private fallback: number|null = null

    constructor (private app: AppService) { }

    activate (): void {
        document.body.classList.add(STARTUP_COVER_CLASS)
        this.app.tabOpened$.subscribe(() => this.finish())

        if (this.app.tabs.length) {
            this.finish()
        } else {
            this.armFallback(2000)
        }
    }

    initialHandshakeReceived (): void {
        this.armFallback(250)
    }

    private armFallback (delay: number): void {
        if (this.fallback !== null) {
            window.clearTimeout(this.fallback)
        }
        this.fallback = window.setTimeout(() => this.finish(), delay)
    }

    private finish (): void {
        document.body.classList.remove(STARTUP_COVER_CLASS)
        if (this.fallback !== null) {
            window.clearTimeout(this.fallback)
            this.fallback = null
        }
    }
}
