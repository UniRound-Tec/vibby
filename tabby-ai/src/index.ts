/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import TabbyCorePlugin, { AppService, CLIHandler, ConfigProvider, ConfigService, HotkeyProvider, ProfileProvider, ToolbarButtonProvider } from 'tabby-core'

import { AiConfigProvider } from './config'
import { AiCliProfileProvider } from './profiles'
import { OpenDashboardCLIHandler } from './cli'
import { ButtonProvider } from './buttonProvider'
import { AiHotkeyProvider } from './hotkeys'
import { CliScannerService } from './services/cliScanner.service'
import { DashboardService } from './services/dashboard.service'
import { DashboardTabComponent } from './components/dashboardTab.component'

@NgModule({
    imports: [
        CommonModule,
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: AiConfigProvider, multi: true },
        { provide: ProfileProvider, useClass: AiCliProfileProvider, multi: true },
        { provide: CLIHandler, useClass: OpenDashboardCLIHandler, multi: true },
        { provide: ToolbarButtonProvider, useClass: ButtonProvider, multi: true },
        { provide: HotkeyProvider, useClass: AiHotkeyProvider, multi: true },
    ],
    declarations: [
        DashboardTabComponent,
    ],
})
export default class AiModule {
    private constructor (
        scanner: CliScannerService,
        app: AppService,
        config: ConfigService,
        dashboard: DashboardService,
    ) {
        scanner.ensureScanned()

        app.ready$.subscribe(() => {
            app.tabsChanged$.subscribe(() => {
                if (app.tabs.length === 0 && config.store.aiCli.dashboard.reopenWhenEmpty) {
                    dashboard.open()
                }
            })
        })
    }
}

export * from './api'
