import { Injectable } from '@angular/core'
import { ProfileProvider, NewTabParameters, Profile, PartialProfile, AppService, SplitTabComponent } from 'tabby-core'
import { TerminalTabComponent, SessionOptions } from 'tabby-local'

import { AiCliMetadata, DetectedCli } from './api'
import { AI_CLI_REGISTRY } from './registry'
import { CliScannerService, wrapCommand } from './services/cliScanner.service'

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
}
