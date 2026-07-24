import { Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton, HotkeysService, TranslateService } from 'tabby-core'

import { DashboardService } from './services/dashboard.service'

/** @hidden */
@Injectable()
export class ButtonProvider extends ToolbarButtonProvider {
    constructor (
        hotkeys: HotkeysService,
        private dashboard: DashboardService,
        private translate: TranslateService,
    ) {
        super()
        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === 'toggle-dashboard') {
                this.dashboard.open()
            }
        })
    }

    provide (): ToolbarButton[] {
        return [{
            icon: require('./icons/home.svg'),
            title: this.translate.instant('Home'),
            weight: -10,
            click: () => this.dashboard.open(),
        }]
    }
}
