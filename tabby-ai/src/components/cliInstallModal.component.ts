import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Injector, Input,
    NgZone, OnDestroy, OnInit, ViewChild,
} from '@angular/core'
import { SafeHtml } from '@angular/platform-browser'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { Subscription } from 'rxjs'
import {
    ConfigService, PlatformService, WIN_BUILD_CONPTY_SUPPORTED, isWindowsBuild,
} from 'tabby-core'
import { PTYInterface, PTYProxy } from 'tabby-local'
import { BaseTerminalProfile, Frontend, XTermFrontend } from 'tabby-terminal'

import { AiCliRegistryEntry } from '../api'
import {
    CliInstallRecipe, InstallPlatform, installPlatformFor, installRecipeFor, installShellCommand,
    installShellEnvironment,
} from '../installRecipes'
import { CliScannerService } from '../services/cliScanner.service'

type InstallState = 'confirm' | 'running' | 'succeeded' | 'failed'

/** @hidden */
@Component({
    templateUrl: './cliInstallModal.component.pug',
    styleUrls: ['./cliInstallModal.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CliInstallModalComponent implements OnInit, OnDestroy {
    @Input() cli!: AiCliRegistryEntry
    @Input() cliIcon: SafeHtml|null = null

    @ViewChild('terminalHost', { read: ElementRef })
    private terminalHost?: ElementRef<HTMLElement>

    state: InstallState = 'confirm'
    platform: InstallPlatform|null = null
    recipe: CliInstallRecipe|null = null
    exitCode: number|null = null
    detectedAfterInstall = false

    get automaticInstallAvailable (): boolean {
        return this.recipe?.support === 'ready' && !!this.recipe.command
    }

    private frontend: Frontend|null = null
    private pty: PTYProxy|null = null
    private frontendSubscriptions = new Subscription()
    private destroyed = false
    private finishing = false
    private lastSize = { columns: 80, rows: 16 }

    constructor (
        private activeModal: NgbActiveModal,
        private injector: Injector,
        private config: ConfigService,
        private scanner: CliScannerService,
        private platformService: PlatformService,
        private zone: NgZone,
        private cdr: ChangeDetectorRef,
    ) { }

    ngOnInit (): void {
        this.platform = installPlatformFor()
        this.recipe = installRecipeFor(this.cli.id, this.platform)
    }

    async install (): Promise<void> {
        if (!this.recipe || !this.automaticInstallAvailable || this.state === 'running') {
            return
        }

        await this.disposeTerminal()
        this.state = 'running'
        this.exitCode = null
        this.detectedAfterInstall = false
        this.finishing = false
        this.cdr.detectChanges()

        // Let Angular create the terminal host before xterm measures it.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        if (this.destroyed || !this.terminalHost) {
            return
        }

        try {
            const frontend = new XTermFrontend(this.injector)
            this.frontend = frontend
            const profile = { terminalColorScheme: null } as BaseTerminalProfile
            await frontend.attach(this.terminalHost.nativeElement, profile)
            frontend.configure(profile)
            frontend.focus()

            this.frontendSubscriptions.add(frontend.input$.subscribe(data => this.pty?.write(data)))
            this.frontendSubscriptions.add(frontend.resize$.subscribe(size => {
                this.lastSize = size
                this.pty?.resize(size.columns, size.rows)
            }))

            await frontend.write(`\x1b[1;36m> ${this.recipe.command!}\x1b[0m\r\n\r\n`)
            const shell = installShellCommand(this.recipe, this.platform)
            const path = this.scanner.shellPath ?? process.env.PATH
            const pty = await this.injector.get(PTYInterface).spawn(shell.command, shell.args, {
                name: 'xterm-256color',
                cols: this.lastSize.columns,
                rows: this.lastSize.rows,
                encoding: null,
                cwd: process.env.USERPROFILE ?? process.env.HOME,
                env: {
                    ...installShellEnvironment(process.env, this.platform),
                    PATH: path,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    TERM_PROGRAM: 'Vibby',
                },
                useConpty: process.platform === 'win32' &&
                    isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED) &&
                    this.config.store.terminal.useConPTY ? 1 : false,
            }) as PTYProxy
            this.pty = pty
            pty.subscribe('data', (array: Uint8Array) => {
                pty.ackData(array.length)
                frontend.write(Buffer.from(array).toString('utf8'))
            })
            pty.subscribe('exit', (code?: number) => this.onExit(code))
            pty.subscribe('close', () => {
                if (this.state === 'running') {
                    this.onExit(1)
                }
            })
        } catch (error) {
            await this.frontend?.write(`\r\n\x1b[31m${String(error)}\x1b[0m\r\n`)
            this.finish(false, 1)
        }
    }

    retry (): void {
        this.install()
    }

    async openDocs (): Promise<void> {
        const url = this.recipe?.sourceUrl ?? this.cli.docsUrl
        if (url) {
            await this.platformService.openExternal(url)
        }
    }

    close (): void {
        if (this.state === 'running') {
            this.pty?.kill()
            this.activeModal.dismiss()
            return
        }
        this.activeModal.close({
            installed: this.state === 'succeeded',
            detected: this.detectedAfterInstall,
        })
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.disposeTerminal()
    }

    private onExit (code?: number): void {
        if (this.state !== 'running' || this.finishing) {
            return
        }
        this.finish(code === 0, typeof code === 'number' ? code : 1)
    }

    private finish (succeeded: boolean, code: number): void {
        this.zone.run(async () => {
            this.finishing = true
            this.exitCode = code
            if (succeeded) {
                const detected = await this.scanner.refresh()
                this.detectedAfterInstall = detected.some(x => x.entry.id === this.cli.id)
            }
            if (!this.destroyed) {
                this.state = succeeded ? 'succeeded' : 'failed'
                this.cdr.markForCheck()
            }
        })
    }

    private async disposeTerminal (): Promise<void> {
        this.frontendSubscriptions.unsubscribe()
        this.frontendSubscriptions = new Subscription()
        const pty = this.pty
        this.pty = null
        if (pty) {
            pty.unsubscribeAll()
            if (this.state === 'running') {
                await pty.kill()
            }
        }
        this.frontend?.destroy()
        this.frontend = null
    }
}
