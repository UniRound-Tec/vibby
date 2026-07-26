import * as os from 'os'
import { Injectable } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import * as shellQuote from 'shell-quote'
import { ProfileProvider, NewTabParameters, Profile, PartialProfile, AppService, SplitTabComponent, TranslateService } from 'tabby-core'
import { TerminalTabComponent, SessionOptions } from 'tabby-local'

import { AiCliMetadata, DetectedCli } from './api'
import { AI_CLI_REGISTRY } from './registry'
import { CliScannerService, wrapCommand } from './services/cliScanner.service'
import { CliLaunchModalComponent, CliLaunchOptions } from './components/cliLaunchModal.component'

export interface AiCliProfile extends Profile {
    options: SessionOptions & { aiCli: AiCliMetadata }
}

@Injectable({ providedIn: 'root' })
export class AiCliProfileProvider extends ProfileProvider<AiCliProfile> {
    id = 'ai-cli'
    name = 'AI CLI'
    configDefaults = {
        options: {
            restoreFromPTYID: null,
            command: '',
            args: [],
            cwd: null,
            env: {
                __nonStructural: true,
            },
            pathPrefix: [],
            width: null,
            height: null,
            shellType: null,
            pauseAfterExit: false,
            runAsAdministrator: false,
            aiCli: {
                kind: null,
                version: null,
                sessionName: null,
            },
        },
    }

    constructor (
        private app: AppService,
        private scanner: CliScannerService,
        private modal: NgbModal,
        private sanitizer: DomSanitizer,
        private translate: TranslateService,
    ) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<AiCliProfile>[]> {
        const clis = await this.scanner.ensureScanned()
        return clis.map(cli => ({
            id: `ai-cli:${cli.entry.id}`,
            type: 'ai-cli',
            name: cli.entry.name,
            icon: cli.entry.icon,
            isBuiltin: true,
            // its own heading in the profile selector and the profiles settings
            // tab, rather than being mixed in with the built-in shells — these
            // are the product, not one more way to get a prompt
            group: 'AI CLI',
            options: this.optionsFromCli(cli),
        }))
    }

    async getNewTabParameters (profile: AiCliProfile): Promise<NewTabParameters<TerminalTabComponent>> {
        profile = {
            ...profile,
            options: { ...profile.options },
        }

        if (!profile.options.cwd) {
            if (this.app.activeTab instanceof TerminalTabComponent && this.app.activeTab.session) {
                profile.options.cwd = await this.app.activeTab.session.getWorkingDirectory() ?? null
            }
            if (this.app.activeTab instanceof SplitTabComponent) {
                const focusedTab = this.app.activeTab.getFocusedTab()

                if (focusedTab instanceof TerminalTabComponent && focusedTab.session) {
                    profile.options.cwd = await focusedTab.session.getWorkingDirectory() ?? null
                }
            }
        }

        return {
            type: TerminalTabComponent,
            inputs: {
                profile,
            },
        }
    }

    async configureForLaunch (profile: AiCliProfile): Promise<PartialProfile<AiCliProfile>|null> {
        const kind = profile.options.aiCli.kind
        const entry = AI_CLI_REGISTRY.find(x => x.id === kind)
        const fallbackCwd = await this.fallbackWorkingDirectory(profile)
        const modal = this.modal.open(CliLaunchModalComponent, {
            centered: true,
        })
        modal.componentInstance.cliName = entry?.name ?? profile.name
        modal.componentInstance.cliIcon = entry
            ? this.sanitizer.bypassSecurityTrustHtml(entry.icon)
            : null
        modal.componentInstance.fallbackName = this.baseName(fallbackCwd) ?? profile.name
        modal.componentInstance.fallbackCwd = fallbackCwd
        modal.componentInstance.fallbackArguments = entry?.launchArgs?.length
            ? shellQuote.quote(entry.launchArgs)
            : this.translate.instant('No additional arguments')

        const launchOptions = await modal.result.catch(() => null) as CliLaunchOptions|null
        if (!launchOptions) {
            return null
        }

        const customName = launchOptions.name.trim()
        return {
            ...profile,
            name: customName ? customName : profile.name,
            options: {
                ...profile.options,
                cwd: launchOptions.cwd ? launchOptions.cwd : profile.options.cwd,
                args: [
                    ...profile.options.args,
                    ...launchOptions.args,
                ],
                aiCli: {
                    ...profile.options.aiCli,
                    ...customName ? { sessionName: customName } : {},
                },
            },
        }
    }

    getSuggestedName (profile: PartialProfile<AiCliProfile>): string|null {
        const kind = profile.options?.aiCli?.kind
        const entry = AI_CLI_REGISTRY.find(x => x.id === kind)
        if (!entry) {
            return null
        }
        const version = profile.options?.aiCli?.version
        return version ? `${entry.name} (${version})` : entry.name
    }

    getDescription (profile: PartialProfile<AiCliProfile>): string {
        return [profile.options?.command, ...profile.options?.args ?? []].filter(x => x).join(' ')
    }

    private optionsFromCli (cli: DetectedCli): AiCliProfile['options'] {
        const wrapped = wrapCommand(cli.command, cli.entry.launchArgs ?? [], cli.launcher)
        return {
            ...this.configDefaults.options,
            env: {},
            command: wrapped.command,
            args: wrapped.args,
            aiCli: {
                kind: cli.entry.id,
                version: cli.version,
            },
        }
    }

    private baseName (dir: string|null|undefined): string|null {
        const name = dir?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
        return name ?? null
    }

    private async fallbackWorkingDirectory (profile: AiCliProfile): Promise<string> {
        if (profile.options.cwd) {
            return profile.options.cwd
        }
        if (this.app.activeTab instanceof TerminalTabComponent && this.app.activeTab.session) {
            const cwd = await this.app.activeTab.session.getWorkingDirectory()
            if (cwd) {
                return cwd
            }
        }
        if (this.app.activeTab instanceof SplitTabComponent) {
            const focusedTab = this.app.activeTab.getFocusedTab()
            if (focusedTab instanceof TerminalTabComponent && focusedTab.session) {
                const cwd = await focusedTab.session.getWorkingDirectory()
                if (cwd) {
                    return cwd
                }
            }
        }
        // not process.env.HOME: it is usually unset on Windows, where the
        // fallback would then be the packaged app's install directory
        return os.homedir()
    }
}
