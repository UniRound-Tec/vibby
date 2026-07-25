import { Component, Input } from '@angular/core'
import { SafeHtml } from '@angular/platform-browser'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import * as shellQuote from 'shell-quote'
import { PlatformService } from 'tabby-core'

export interface CliLaunchOptions {
    name: string
    cwd: string
    args: string[]
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

    name = ''
    cwd = ''
    arguments = ''
    argumentsInvalid = false

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
            } satisfies CliLaunchOptions)
        } catch {
            this.argumentsInvalid = true
        }
    }

    cancel (): void {
        this.activeModal.dismiss()
    }
}
