/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'

import { ProfilesService } from './services/profiles.service'
import { CommandProvider, Command, CommandLocation } from './api/commands'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class CoreCommandProvider extends CommandProvider {
    constructor (
        private profilesService: ProfilesService,
        private translate: TranslateService,
    ) {
        super()
    }

    async activate () {
        const profile = await this.profilesService.showProfileSelector().catch(() => null)
        if (profile) {
            this.profilesService.launchProfile(profile)
        }
    }

    async provide (): Promise<Command[]> {
        return [
            {
                id: 'core:profile-selector',
                locations: [CommandLocation.LeftToolbar, CommandLocation.StartPage],
                label: this.translate.instant('Profiles & connections'),
                // vibby: a plus on every platform, not just Web. This is the
                // only "new tab" affordance in the rail now that local's "+"
                // button is unregistered, so it has to read as one.
                icon: require('./icons/plus.svg'),
                run: async () => this.activate(),
            },
            ...this.profilesService.getRecentProfiles().map((profile, index) => ({
                id: `core:recent-profile-${index}`,
                label: profile.name,
                locations: [CommandLocation.StartPage],
                icon: require('./icons/history.svg'),
                run: async () => {
                    const p = (await this.profilesService.getProfiles()).find(x => x.id === profile.id) ?? profile
                    this.profilesService.launchProfile(p)
                },
            })),
        ]
    }
}
