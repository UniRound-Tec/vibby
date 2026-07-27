import { Component, Input } from '@angular/core'
import { SafeHtml } from '@angular/platform-browser'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import * as shellQuote from 'shell-quote'
import { PlatformService } from 'tabby-core'

export interface CliLaunchOptions {
    name: string
    cwd: string
    args: string[]
    targetId: string
}

export interface CliLaunchTargetOption {
    id: string
    label: string
    detail: string
    type: 'native'|'wsl'
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
        const cwd = await this.platform.pickDirectory()
        if (cwd) {
            this.cwd = cwd
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
