/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCorePlugin, { AppService, CLIHandler, ConfigProvider, ConfigService, HotkeyProvider, HotkeysService, ProfileProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { AiConfigProvider } from './config'
import { AiCliProfileProvider } from './profiles'
import { OpenDashboardCLIHandler } from './cli'
import { AiHotkeyProvider } from './hotkeys'
import { AiSettingsTabProvider } from './settings'
import { CliScannerService } from './services/cliScanner.service'
import { DashboardService } from './services/dashboard.service'
import { HookIngressService } from './services/hookIngress.service'
import { DashboardTabComponent } from './components/dashboardTab.component'
import { AiSettingsTabComponent } from './components/aiSettingsTab.component'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: AiConfigProvider, multi: true },
        { provide: ProfileProvider, useClass: AiCliProfileProvider, multi: true },
        { provide: CLIHandler, useClass: OpenDashboardCLIHandler, multi: true },
        { provide: HotkeyProvider, useClass: AiHotkeyProvider, multi: true },
        { provide: SettingsTabProvider, useClass: AiSettingsTabProvider, multi: true },
    ],
    declarations: [
        DashboardTabComponent,
        AiSettingsTabComponent,
    ],
})
export default class AiModule {
    private constructor (
        scanner: CliScannerService,
        app: AppService,
        config: ConfigService,
        dashboard: DashboardService,
        hotkeys: HotkeysService,
        ingress: HookIngressService,
    ) {
        scanner.ensureScanned()
        ingress.start().then(() => {
            console.debug(`[tabby-ai] ingress endpoint template: ${ingress.endpointFor('SESSION')}`)
        }).catch(() => null)
        this.injectMiniTabStyles()

        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === 'toggle-dashboard') {
                dashboard.open()
            }
        })

        app.ready$.subscribe(() => {
            app.tabsChanged$.subscribe(() => {
                if (app.tabs.length === 0 && config.store.aiCli.dashboard.reopenWhenEmpty) {
                    dashboard.open()
                }
            })
        })
    }

    /** Compact icon-only header for the pinned dashboard tab (targets tab-header.mini) */
    private injectMiniTabStyles (): void {
        const homeIcon: string = require('./icons/home.svg')
        const mask = `url("data:image/svg+xml,${encodeURIComponent(homeIcon)}") center / contain no-repeat`
        const style = document.createElement('style')
        style.textContent = `
            tab-header.mini {
                width: 52px !important;
                flex: 0 0 52px !important;
                min-width: 52px !important;
            }
            tab-header.mini .index,
            tab-header.mini .pin-indicator,
            tab-header.mini .buttons,
            tab-header.mini .name { display: none !important; }
            tab-header.mini::after {
                content: '';
                position: absolute;
                left: 50%;
                top: 50%;
                width: 14px;
                height: 14px;
                transform: translate(-50%, -50%);
                background: currentColor;
                opacity: .6;
                -webkit-mask: ${mask};
                mask: ${mask};
                pointer-events: none;
            }
            tab-header.mini.active::after { opacity: 1; }
        `
        document.head.appendChild(style)
    }
}

export * from './api'
