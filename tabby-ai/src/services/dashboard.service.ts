import { Injectable } from '@angular/core'
import { AppService } from 'tabby-core'
import { DashboardTabComponent } from '../components/dashboardTab.component'

@Injectable({ providedIn: 'root' })
export class DashboardService {
    constructor (private app: AppService) { }

    find (): DashboardTabComponent|null {
        return (this.app.tabs.find(x => x instanceof DashboardTabComponent) ?? null) as DashboardTabComponent|null
    }

    open (): void {
        const existing = this.find()
        if (existing) {
            this.app.selectTab(existing)
        } else {
            const tab = this.app.openNewTabRaw({ type: DashboardTabComponent })
            this.app.pinTab(tab)
        }
    }
}
