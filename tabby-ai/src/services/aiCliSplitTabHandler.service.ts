import { Injectable } from '@angular/core'
import { BaseTabComponent, ProfilesService, SplitTabHandler, TabsService } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { RuntimeCliDetectorService } from './runtimeCliDetector.service'

@Injectable()
export class AiCliSplitTabHandler extends SplitTabHandler {
    constructor (
        private profiles: ProfilesService,
        private tabs: TabsService,
        private runtimeDetector: RuntimeCliDetectorService,
    ) {
        super()
    }

    supports (tab: BaseTabComponent): boolean {
        return tab instanceof TerminalTabComponent
            && (tab.profile.type === 'ai-cli' || !!this.runtimeDetector.kindForPane(tab))
    }

    async create (_tab: BaseTabComponent): Promise<BaseTabComponent|null> {
        const profile = await this.profiles.showProfileSelector().catch(() => null)
        if (!profile) {
            return null
        }

        const configuredProfile = await this.profiles.configureProfileForLaunch(profile)
        if (!configuredProfile) {
            return null
        }

        const params = await this.profiles.newTabParametersForProfile(configuredProfile)
        return params ? this.tabs.create(params) : null
    }
}
