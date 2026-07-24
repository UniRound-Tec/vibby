import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider, TranslateService } from 'tabby-core'

/** @hidden */
@Injectable()
export class AiHotkeyProvider extends HotkeyProvider {
    constructor (private translate: TranslateService) {
        super()
    }

    async provide (): Promise<HotkeyDescription[]> {
        return [{
            id: 'toggle-dashboard',
            name: this.translate.instant('Open the AI dashboard'),
        }]
    }
}
