import { Injectable } from '@angular/core'
import { AppService, CLIHandler, CLIEvent, ConfigService } from 'tabby-core'

import { DashboardService } from './services/dashboard.service'
import { StartupCoverService } from './services/startupCover.service'

/**
 * Opens the dashboard on a plain launch (empty argv + openOnStart).
 * priority 0 with firstMatchOnly short-circuits tabby-local's
 * AutoOpenTabCLIHandler (priority -1000), so no default terminal is
 * auto-opened. Path / profile / other subcommands are left untouched.
 *
 * Empty-argv second-instance launches are also claimed: the single-instance
 * lock already focuses an existing window, and returning true prevents
 * tabby-core's LastCLIHandler from spawning an empty window that would
 * fall through to Tabby's start-page.
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
        if (event.argv._.length !== 0) {
            return false
        }
        if (!this.config.store.aiCli.dashboard.openOnStart) {
            return false
        }
        if (event.secondInstance) {
            this.dashboard.open()
            return true
        }
        this.app.ready$.subscribe(() => {
            this.dashboard.open()
        })
        return true
    }
}
