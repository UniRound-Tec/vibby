import { Injectable } from '@angular/core'
import { Command, CommandLocation, CommandProvider, TranslateService } from 'tabby-core'

import { DashboardService } from './services/dashboard.service'
import { RailService } from './services/rail.service'

/**
 * Home lives in the tab bar's toolbar rather than in the tab list — on side
 * bars the list is for sessions only (docs/mockups/sidebar.html, variant D).
 */
@Injectable({ providedIn: 'root' })
export class AiCommandProvider extends CommandProvider {
    constructor (
        private dashboard: DashboardService,
        private rail: RailService,
        private translate: TranslateService,
    ) {
        super()
    }

    async provide (): Promise<Command[]> {
        return [{
            id: 'ai:dashboard',
            locations: [CommandLocation.LeftToolbar],
            label: this.translate.instant('Home'),
            icon: require('./icons/home.svg'),
            weight: -10,
            run: async () => this.dashboard.open(),
        }, {
            id: 'ai:toggle-rail',
            locations: [CommandLocation.LeftToolbar],
            // core reads the toolbar once at startup, so the label cannot
            // name a direction — it has to describe both halves of the toggle
            label: this.translate.instant('Toggle sidebar'),
            icon: require('./icons/rail.svg'),
            weight: -9,
            run: async () => this.rail.toggle(),
        }]
    }
}
