import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

/**
 * Scope for every collapsed-rail rule in the injected stylesheet. It goes on
 * <body> rather than on .content because the stylesheet lives outside Angular
 * and has no component to bind a class to.
 */
export const COLLAPSED_CLASS = 'vibby-rail-collapsed'

/**
 * The side rail's collapsed state. Just a persisted boolean mirrored onto the
 * document — all the layout lives in CSS, so nothing here has to know what a
 * collapsed tab looks like.
 */
@Injectable({ providedIn: 'root' })
export class RailService {
    constructor (private config: ConfigService) { }

    activate (): void {
        this.config.ready$.toPromise().then(() => this.apply())
        // keeps the two windows of a synced config in step, and picks up
        // anyone editing the key by hand
        this.config.changed$.subscribe(() => this.apply())
    }

    get collapsed (): boolean {
        return this.config.store?.aiCli?.rail?.collapsed ?? false
    }

    toggle (): void {
        this.config.store.aiCli.rail.collapsed = !this.collapsed
        this.config.save()
        this.apply()
    }

    private apply (): void {
        document.body.classList.toggle(COLLAPSED_CLASS, this.collapsed)
    }
}
