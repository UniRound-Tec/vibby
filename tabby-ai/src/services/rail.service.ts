import { Injectable, NgZone } from '@angular/core'
import { AppService, ConfigService, TranslateService } from 'tabby-core'
import { VIBBY_WORDMARK } from '../branding'
import { DashboardService } from './dashboard.service'

/**
 * Scope for every collapsed-rail rule in the injected stylesheet. It goes on
 * <body> rather than on .content because the stylesheet lives outside Angular
 * and has no component to bind a class to.
 */
export const COLLAPSED_CLASS = 'vibby-rail-collapsed'
const EMPTY_STATE_CLASS = 'vibby-rail-empty'

/**
 * The side rail's collapsed state. Just a persisted boolean mirrored onto the
 * document — all the layout lives in CSS, so nothing here has to know what a
 * collapsed tab looks like.
 */
@Injectable({ providedIn: 'root' })
export class RailService {
    private emptyState: HTMLDivElement|null = null

    constructor (
        private config: ConfigService,
        private app: AppService,
        private dashboard: DashboardService,
        private translate: TranslateService,
        private zone: NgZone,
    ) { }

    activate (): void {
        this.config.ready$.toPromise().then(() => {
            this.apply()
            this.updateEmptyState()
        })
        this.app.ready$.subscribe(() => setTimeout(() => this.updateEmptyState()))
        this.app.tabsChanged$.subscribe(() => setTimeout(() => this.updateEmptyState()))
        // keeps the two windows of a synced config in step, and picks up
        // anyone editing the key by hand; locale also travels through config
        this.config.changed$.subscribe(() => {
            this.apply()
            this.updateEmptyState()
        })
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

    /**
     * The dashboard and settings are intentionally hidden from the session
     * rail. When they are the only tabs, leave a real affordance in the space
     * instead of an unexplained blank column. This lives here rather than in
     * core so the Tabby-side markup stays generic.
     */
    private updateEmptyState (): void {
        const empty = this.ensureEmptyState()
        if (!empty) {
            return
        }
        empty.hidden = this.app.tabs.some(tab => !tab['miniHeader'])
        empty.querySelector<HTMLButtonElement>('button')!.textContent =
            `＋ ${this.translate.instant('New session')}`
    }

    private ensureEmptyState (): HTMLDivElement|null {
        const host = document.querySelector<HTMLElement>('.content.main > .tab-bar > .tabs')
        if (!host) {
            return null
        }
        if (this.emptyState?.parentElement === host) {
            return this.emptyState
        }

        const empty = document.createElement('div')
        empty.className = EMPTY_STATE_CLASS
        empty.setAttribute('aria-live', 'polite')

        const brand = document.createElement('img')
        brand.className = 'vibby-rail-empty-brand'
        brand.src = VIBBY_WORDMARK
        brand.alt = 'Vibby'
        empty.appendChild(brand)

        const button = document.createElement('button')
        button.type = 'button'
        button.addEventListener('click', event => {
            event.stopPropagation()
            this.zone.run(() => this.dashboard.open())
        })
        empty.appendChild(button)

        host.appendChild(empty)
        this.emptyState = empty
        return empty
    }
}
