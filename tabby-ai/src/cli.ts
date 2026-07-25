import { Injectable } from '@angular/core'
import { AppService, CLIHandler, CLIEvent, ConfigService } from 'tabby-core'

import { DashboardService } from './services/dashboard.service'
import { StartupCoverService } from './services/startupCover.service'

/**
 * Opens the dashboard on a plain main-instance launch. priority 0 with
 * firstMatchOnly short-circuits tabby-local's AutoOpenTabCLIHandler
 * (priority -1000), so no default terminal is auto-opened. Any launch
 * with subcommands/paths or from a second instance is left untouched.
 */
@Injectable()
export class OpenDashboardCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = 0

    constructor (
        private app: AppService,
        private config: ConfigService,
        private dashboard: DashboardService,
        private startupCover: StartupCoverService,
    ) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        if (!event.secondInstance) {
            this.startupCover.initialHandshakeReceived()
        }
        if (event.secondInstance || event.argv._.length !== 0) {
            return false
        }
        if (!this.config.store.aiCli.dashboard.openOnStart) {
            return false
        }
        this.app.ready$.subscribe(() => {
            this.dashboard.open()
        })
        return true
    }
}
