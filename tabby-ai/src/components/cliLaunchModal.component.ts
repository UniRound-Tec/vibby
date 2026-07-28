import { Component, Input } from '@angular/core'
import { SafeHtml } from '@angular/platform-browser'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import * as shellQuote from 'shell-quote'
import { PlatformService } from 'tabby-core'

export interface CliLaunchOptions {
    name: string
    cwd: string
    args: string[]
    rawArguments: string
    targetId: string
}

export interface CliLaunchTargetOption {
    id: string
    label: string
    detail: string
    type: 'native'|'wsl'
    wslDistribution?: string
}

export function wslPickerRoot (distribution: string): string {
    // The legacy share remains the most reliable defaultPath for Windows'
    // Common Item Dialog. \\wsl.localhost is readable but some dialog builds
    // fail to open when it is supplied as the initial folder.
    return `\\\\wsl$\\${distribution}`
}

export function linuxPathFromWslPicker (
    distribution: string,
    selectedPath: string,
): string|null {
    const normalized = selectedPath
        .replace(/\//g, '\\')
        .replace(/^\\\\\?\\UNC\\/i, '\\\\')
        .replace(/\\+$/, '')
    const roots = [
        `\\\\wsl.localhost\\${distribution}`,
        `\\\\wsl$\\${distribution}`,
    ]
    for (const root of roots) {
        if (normalized.toLowerCase() === root.toLowerCase()) {
            return '/'
        }
        const prefix = `${root}\\`
        if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
            return `/${normalized.slice(prefix.length).replace(/\\/g, '/')}`
        }
    }
    return null
}

/** @hidden */
@Component({
    templateUrl: './cliLaunchModal.component.pug',
    styleUrls: ['./cliLaunchModal.component.scss'],
})
export class CliLaunchModalComponent {
    @Input() cliName = ''
    @Input() cliIcon: SafeHtml|null = null
    @Input() fallbackName = ''
    @Input() fallbackCwd = ''
    @Input() fallbackArguments = ''
    @Input() targets: CliLaunchTargetOption[] = []
    @Input() selectedTargetId = 'native'

    name = ''
    cwd = ''
    arguments = ''
    argumentsInvalid = false

    get displayedFallbackCwd (): string {
        return this.targets.find(target => target.id === this.selectedTargetId)?.type === 'wsl'
            ? '~'
            : this.fallbackCwd
    }

    constructor (
        private activeModal: NgbActiveModal,
        private platform: PlatformService,
    ) { }

    async pickWorkingDirectory (): Promise<void> {
        const target = this.targets.find(item => item.id === this.selectedTargetId)
        const distribution = target?.type === 'wsl' ? target.wslDistribution : null
        const cwd = await this.platform.pickDirectory(
            undefined,
            undefined,
            distribution ? wslPickerRoot(distribution) : undefined,
        )
        if (cwd) {
            this.cwd = distribution
                ? linuxPathFromWslPicker(distribution, cwd) ?? cwd
                : cwd
        }
    }

    start (): void {
        try {
            const args = shellQuote.parse(this.arguments)
            if (args.some(arg => typeof arg !== 'string')) {
                throw new Error('Arguments contain shell operators')
            }
            this.argumentsInvalid = false
            this.activeModal.close({
                name: this.name.trim(),
                cwd: this.cwd.trim(),
                args: args as string[],
                rawArguments: this.arguments,
                targetId: this.selectedTargetId,
            } satisfies CliLaunchOptions)
        } catch {
            this.argumentsInvalid = true
        }
    }

    cancel (): void {
        this.activeModal.dismiss()
    }
}
