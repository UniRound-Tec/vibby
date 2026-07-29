import { Injectable, NgZone } from '@angular/core'
import { AppService, ConfigService, TranslateService } from 'tabby-core'
import { VIBBY_WORDMARK } from '../branding'
import { AI_CLI_REGISTRY } from '../registry'
import { isReadmeDemo, readmeDemoSessions } from '../readmeDemo'
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
    private emptyState: HTMLDivElement | null = null
    private demoCards: HTMLElement[] = []

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
        if (isReadmeDemo()) {
            // Home finishes mounting a beat after ready$; keep re-painting until
            // the tab strip exists so README screenshots get a filled rail.
            const paint = () => this.updateEmptyState()
            setTimeout(paint, 300)
            setTimeout(paint, 1200)
            setTimeout(paint, 2500)
        }
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
        if (isReadmeDemo()) {
            this.renderDemoRail()
            return
        }
        this.clearDemoRail()
        const empty = this.ensureEmptyState()
        if (!empty) {
            return
        }
        empty.hidden = this.app.tabs.some(tab => !tab['miniHeader'])
        empty.querySelector<HTMLButtonElement>('button')!.textContent =
            `＋ ${this.translate.instant('New session')}`
    }

    /** Fake session cards for README screenshots — real CSS, synthetic markup. */
    private renderDemoRail (): void {
        const host = document.querySelector<HTMLElement>('.content.main > .tab-bar > .tabs')
        if (!host) {
            return
        }
        if (this.emptyState) {
            this.emptyState.hidden = true
        }
        this.clearDemoRail()

        const sessionsLabel = this.translate.instant('Sessions')
        // Insert as direct children of `.tabs` so existing `tab-header` CSS matches.
        const anchor = host.firstChild
        readmeDemoSessions().forEach((session, index) => {
            const card = document.createElement('tab-header')
            card.setAttribute('data-vibby-readme-demo', '1')
            if (index === 0) {
                card.classList.add('active')
                card.setAttribute('data-ai-group', sessionsLabel)
            }

            const indexEl = document.createElement('div')
            indexEl.className = 'index'
            indexEl.textContent = String(index + 1)

            const iconWrap = document.createElement('div')
            iconWrap.className = 'ai-icon'
            const icon = AI_CLI_REGISTRY.find(entry => entry.id === session.kind)?.icon
            if (icon) {
                iconWrap.innerHTML = icon
            }

            const name = document.createElement('div')
            name.className = 'name'
            name.textContent = session.name

            const state = document.createElement('div')
            state.className = `ai-state ${session.state}`
            state.textContent = session.stateLabel

            const summary = document.createElement('div')
            summary.className = 'ai-summary'
            summary.textContent = session.caption

            card.append(indexEl, iconWrap, name, state, summary)
            host.insertBefore(card, anchor)
            this.demoCards.push(card)
        })
    }

    private clearDemoRail (): void {
        for (const card of this.demoCards) {
            card.remove()
        }
        this.demoCards = []
        document.querySelectorAll('[data-vibby-readme-demo="1"]').forEach(node => node.remove())
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
