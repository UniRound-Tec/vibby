/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import TabbyCorePlugin, { AppService, ConfigProvider, ProfileProvider } from 'tabby-core'

import { AiConfigProvider } from './config'
import { AiCliProfileProvider } from './profiles'
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
    ],
    declarations: [
        DashboardTabComponent,
    ],
})
export default class AiModule {
    private constructor (
        scanner: CliScannerService,
        app: AppService,
        dashboard: DashboardService,
    ) {
        scanner.ensureScanned()
        // TEMP-WP3: open dashboard on ready for verification; replaced by CLIHandler coordination in WP4
        app.ready$.subscribe(() => dashboard.open())
    }
}

export * from './api'
