import { Component, ElementRef, Injector } from '@angular/core'
import { DomSanitizer, SafeHtml } from '@angular/platform-browser'
import { BaseTabComponent, AppService, ConfigService, ProfilesService, SplitTabComponent, TranslateService } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

import { DetectedCli } from '../api'
import { AI_CLI_REGISTRY } from '../registry'
import { CliScannerService } from '../services/cliScanner.service'

export interface AiSessionRow {
    topTab: BaseTabComponent
    pane: TerminalTabComponent
    kind: string|null
}

/** @hidden */
@Component({
    selector: 'ai-dashboard-tab',
    templateUrl: './dashboardTab.component.pug',
    styleUrls: ['./dashboardTab.component.scss'],
})
export class DashboardTabComponent extends BaseTabComponent {
    rows: AiSessionRow[] = []
    clis: DetectedCli[] = []
    scanning = false

    private watchedSplits = new Set<SplitTabComponent>()
    private iconCache = new Map<string, SafeHtml>()

    constructor (
        injector: Injector,
        private app: AppService,
        private configService: ConfigService,
        private profilesService: ProfilesService,
        private scanner: CliScannerService,
        private sanitizer: DomSanitizer,
        private host: ElementRef,
        translate: TranslateService,
    ) {
        super(injector)
        this.setTitle(translate.instant('Home'))
        this.subscribeUntilDestroyed(this.app.tabsChanged$, () => this.refreshRows())
        this.subscribeUntilDestroyed(this.scanner.scanResults$, clis => this.clis = clis)
        this.subscribeUntilDestroyed(this.scanner.scanning$, scanning => this.scanning = scanning)
        this.subscribeUntilDestroyed(this.configService.changed$, () => this.applyThemeVars())
        this.refreshRows()
        this.scanner.ensureScanned()
    }

    ngOnInit (): void {
        this.applyThemeVars()
    }

    refreshRows (): void {
        const rows: AiSessionRow[] = []
        for (const topTab of this.app.tabs) {
            const panes = topTab instanceof SplitTabComponent ? topTab.getAllTabs() : [topTab]
            if (topTab instanceof SplitTabComponent && !this.watchedSplits.has(topTab)) {
                this.watchedSplits.add(topTab)
                this.subscribeUntilDestroyed(topTab.tabAdded$, () => this.refreshRows())
                this.subscribeUntilDestroyed(topTab.tabRemoved$, () => this.refreshRows())
            }
            for (const pane of panes) {
                if (pane instanceof TerminalTabComponent && pane.profile?.type === 'ai-cli') {
                    rows.push({
                        topTab,
                        pane,
                        kind: pane.profile.options?.['aiCli']?.kind ?? null,
                    })
                }
            }
        }
        this.rows = rows
    }

    focusRow (row: AiSessionRow): void {
        this.app.selectTab(row.topTab)
        if (row.topTab instanceof SplitTabComponent) {
            row.topTab.focus(row.pane)
        }
    }

    async launch (cli: DetectedCli): Promise<void> {
        const profiles = await this.profilesService.getProfiles()
        const profile = profiles.find(x => x.id === `ai-cli:${cli.entry.id}`)
        if (profile) {
            await this.profilesService.launchProfile(profile)
        }
    }

    rescan (): void {
        this.scanner.scan()
    }

    iconForKind (kind: string|null): SafeHtml|null {
        if (!kind) {
            return null
        }
        if (!this.iconCache.has(kind)) {
            const entry = AI_CLI_REGISTRY.find(x => x.id === kind)
            if (!entry) {
                return null
            }
            this.iconCache.set(kind, this.sanitizer.bypassSecurityTrustHtml(entry.icon))
        }
        return this.iconCache.get(kind) ?? null
    }

    private applyThemeVars (): void {
        const style = this.host.nativeElement.style
        const terminal = this.configService.store.terminal ?? {}
        const colors: string[] = terminal.colorScheme?.colors ?? []
        style.setProperty('--ai-mono', terminal.font ?? 'monospace')
        style.setProperty('--ai-red', colors[1] ?? '#e06c75')
        style.setProperty('--ai-green', colors[2] ?? '#98c379')
        style.setProperty('--ai-yellow', colors[3] ?? '#f0c674')
        style.setProperty('--ai-blue', colors[4] ?? '#61afef')
    }
}
