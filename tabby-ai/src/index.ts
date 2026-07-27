/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCorePlugin, { AppService, CLIHandler, CommandProvider, ConfigProvider, ConfigService, HotkeyProvider, HotkeysService, ProfileProvider, SplitTabHandler } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { AiConfigProvider } from './config'
import { AiCliProfileProvider } from './profiles'
import { OpenDashboardCLIHandler } from './cli'
import { AiHotkeyProvider } from './hotkeys'
import { AiSettingsTabProvider } from './settings'
import { AiCommandProvider } from './commands'
import { CliScannerService } from './services/cliScanner.service'
import { DashboardService } from './services/dashboard.service'
import { HookIngressService } from './services/hookIngress.service'
import { ClaudeAdapterService } from './services/claudeAdapter.service'
import { OpenCodeAdapterService } from './services/openCodeAdapter.service'
import { AiAttentionService } from './services/attention.service'
import { AiTabStateService } from './services/tabState.service'
import { RuntimeCliDetectorService } from './services/runtimeCliDetector.service'
import { AiCliSplitTabHandler } from './services/aiCliSplitTabHandler.service'
import { COLLAPSED_CLASS, RailService } from './services/rail.service'
import { STARTUP_COVER_CLASS, StartupCoverService } from './services/startupCover.service'
import { DashboardTabComponent } from './components/dashboardTab.component'
import { AiSettingsTabComponent } from './components/aiSettingsTab.component'
import { CliLaunchModalComponent } from './components/cliLaunchModal.component'
import { tabBarStyles } from './styles/tabBar.styles'

/** Follows the active Tabby theme instead of imposing a fixed brand colour. */
const ACCENT = 'var(--theme-primary)'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: AiConfigProvider, multi: true },
        { provide: ProfileProvider, useClass: AiCliProfileProvider, multi: true },
        { provide: CLIHandler, useClass: OpenDashboardCLIHandler, multi: true },
        { provide: HotkeyProvider, useClass: AiHotkeyProvider, multi: true },
        { provide: SettingsTabProvider, useClass: AiSettingsTabProvider, multi: true },
        { provide: CommandProvider, useClass: AiCommandProvider, multi: true },
        { provide: SplitTabHandler, useClass: AiCliSplitTabHandler, multi: true },
    ],
    declarations: [
        DashboardTabComponent,
        AiSettingsTabComponent,
        CliLaunchModalComponent,
    ],
})
export default class AiModule {
    private constructor (
        scanner: CliScannerService,
        app: AppService,
        config: ConfigService,
        dashboard: DashboardService,
        hotkeys: HotkeysService,
        ingress: HookIngressService,
        claudeAdapter: ClaudeAdapterService,
        openCodeAdapter: OpenCodeAdapterService,
        attention: AiAttentionService,
        tabState: AiTabStateService,
        runtimeDetector: RuntimeCliDetectorService,
        rail: RailService,
        startupCover: StartupCoverService,
    ) {
        startupCover.activate()
        scanner.ensureScanned()
        ingress.start().then(() => {
            console.debug(`[tabby-ai] ingress endpoint template: ${ingress.endpointFor('SESSION')}`)
        }).catch(() => null)
        // a reloaded renderer would otherwise leave the old listener bound
        window.addEventListener('beforeunload', () => ingress.stop())
        claudeAdapter.activate()
        openCodeAdapter.activate()
        runtimeDetector.activate()
        attention.activate()
        tabState.activate()
        rail.activate()
        this.injectTabBarStyles()

        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === 'toggle-dashboard') {
                dashboard.open()
            }
        })

        app.ready$.subscribe(() => {
            app.tabsChanged$.subscribe(() => {
                if (app.tabs.length === 0 && config.store.aiCli.dashboard.reopenWhenEmpty) {
                    dashboard.open()
                }
            })
        })
    }

    /** The stylesheet lives in styles/tabBar.styles.ts */
    private injectTabBarStyles (): void {
        const style = document.createElement('style')
        style.textContent = tabBarStyles({
            accent: ACCENT,
            collapsedClass: COLLAPSED_CLASS,
            coverClass: STARTUP_COVER_CLASS,
        })
        document.head.appendChild(style)
    }
}

export * from './api'
