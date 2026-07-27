import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { AiSessionDirectoryService } from './sessionDirectory.service'

@Injectable({ providedIn: 'root' })
export class AiSessionNavigatorService {
    constructor (
        private app: AppService,
        private sessions: AiSessionDirectoryService,
    ) { }

    focus (sessionId: string): boolean {
        const pane = this.sessions.forSession(sessionId)?.pane ?? null
        return pane ? this.focusPane(pane) : false
    }

    focusPane (pane: TerminalTabComponent): boolean {
        const topTab = this.topTabFor(pane)
        if (!topTab) {
            return false
        }
        this.app.selectTab(topTab)
        if (topTab instanceof SplitTabComponent) {
            topTab.focus(pane)
        }
        return true
    }

    topTabFor (pane: TerminalTabComponent): BaseTabComponent | null {
        return this.app.tabs.find(tab =>
            tab === pane ||
            tab instanceof SplitTabComponent && tab.getAllTabs().includes(pane),
        ) ?? null
    }
}
