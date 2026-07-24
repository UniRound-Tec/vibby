/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import TabbyCorePlugin, { ConfigProvider, ProfileProvider } from 'tabby-core'

import { AiConfigProvider } from './config'
import { AiCliProfileProvider } from './profiles'
import { CliScannerService } from './services/cliScanner.service'

@NgModule({
    imports: [
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: AiConfigProvider, multi: true },
        { provide: ProfileProvider, useClass: AiCliProfileProvider, multi: true },
    ],
})
export default class AiModule {
    private constructor (
        scanner: CliScannerService,
    ) {
        scanner.ensureScanned()
    }
}

export * from './api'
