import { Injectable } from '@angular/core'
import { Command, CommandLocation, CommandProvider, TranslateService } from 'tabby-core'

import { DashboardService } from './services/dashboard.service'

/**
 * Home lives in the tab bar's toolbar rather than in the tab list — on side
 * bars the list is for sessions only (docs/mockups/sidebar.html, variant D).
 */
@Injectable({ providedIn: 'root' })
export class AiCommandProvider extends CommandProvider {
    constructor (
        private dashboard: DashboardService,
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
        }]
    }
}
