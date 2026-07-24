import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { AiSettingsTabComponent } from './components/aiSettingsTab.component'

/** @hidden */
@Injectable()
export class AiSettingsTabProvider extends SettingsTabProvider {
    id = 'ai-cli'
    icon = 'robot'
    title = 'AI CLI'

    getComponentType (): any {
        return AiSettingsTabComponent
    }
}
