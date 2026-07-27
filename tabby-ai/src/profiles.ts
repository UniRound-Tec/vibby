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
import {
    CliLaunchModalComponent, CliLaunchOptions, CliLaunchTargetOption,
} from './components/cliLaunchModal.component'
import { preferredRuntimeTarget, wslLaunchCommand } from './runtimeTargets'

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
                targetId: null,
                targetCwd: null,
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
        return AI_CLI_REGISTRY.flatMap(entry => {
            const detected = preferredRuntimeTarget(clis.filter(cli => cli.entry.id === entry.id))
            return detected ? [{
                id: `ai-cli:${entry.id}`,
                type: 'ai-cli',
                name: entry.name,
                icon: entry.icon,
                isBuiltin: true,
                // its own heading in the profile selector and the profiles settings
                // tab, rather than being mixed in with the built-in shells — these
                // are the product, not one more way to get a prompt
                group: 'AI CLI',
                options: this.optionsFromCli(detected),
            }] : []
        })
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
        const detections = this.scanner.scanResults.filter(item => item.entry.id === kind)
        const selected = preferredRuntimeTarget(detections, profile.options.aiCli.targetId)
        if (!selected) {
            return null
        }
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
        modal.componentInstance.targets = detections.map(cli => ({
            id: cli.target.id,
            label: cli.target.type === 'wsl'
                ? `${cli.target.label} (WSL ${cli.target.wslVersion ?? '?'})`
                : cli.target.label,
            detail: [
                cli.version ?? this.translate.instant('Version unknown'),
                cli.monitoring === 'full'
                    ? this.translate.instant('Listening')
                    : null,
            ].filter((value): value is string => !!value).join(' · '),
            type: cli.target.type,
        } satisfies CliLaunchTargetOption))
        modal.componentInstance.selectedTargetId = selected.target.id

        const launchOptions = await modal.result.catch(() => null) as CliLaunchOptions|null
        if (!launchOptions) {
            return null
        }

        const customName = launchOptions.name.trim()
        const selectedCli = detections.find(item => item.target.id === launchOptions.targetId) ?? selected
        const targetCwd = launchOptions.cwd ||
            (selectedCli.target.type === 'wsl' ? '~' : fallbackCwd)
        const launchOptionsForTarget = this.optionsFromCli(selectedCli, launchOptions.args, targetCwd)
        return {
            ...profile,
            name: customName ? customName : profile.name,
            options: {
                ...launchOptionsForTarget,
                aiCli: {
                    ...launchOptionsForTarget.aiCli,
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

    private optionsFromCli (
        cli: DetectedCli,
        additionalArgs: string[] = [],
        targetCwd?: string|null,
    ): AiCliProfile['options'] {
        const args = [...cli.entry.launchArgs ?? [], ...additionalArgs]
        const wrapped = cli.target.type === 'wsl'
            ? wslLaunchCommand(cli.target, cli.command, args, targetCwd)
            : wrapCommand(cli.command, args, cli.launcher)
        return {
            ...this.configDefaults.options,
            // a GUI-launched app on macOS/Linux has a minimal PATH; the CLI's
            // `#!/usr/bin/env node` line needs the login shell's one to resolve
            env: cli.target.type === 'native' && this.scanner.shellPath
                ? { PATH: this.scanner.shellPath }
                : {},
            cwd: cli.target.type === 'native' ? targetCwd ?? null : null,
            command: wrapped.command,
            args: wrapped.args,
            aiCli: {
                kind: cli.entry.id,
                version: cli.version,
                targetId: cli.target.id,
                targetCwd: targetCwd ?? null,
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
