/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import TabbyCorePlugin, { ConfigProvider } from 'tabby-core'

import { AiConfigProvider } from './config'
import { CliScannerService } from './services/cliScanner.service'

@NgModule({
    imports: [
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: AiConfigProvider, multi: true },
    ],
})
export default class AiModule {
    private constructor (
        scanner: CliScannerService,
    ) {
        scanner.scan()
    }
}

export * from './api'
