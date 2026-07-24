import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'

import { AI_CLI_REGISTRY } from '../registry'
import { AiCliRegistryEntry } from '../api'
import { CliScannerService } from '../services/cliScanner.service'

/** @hidden */
@Component({
    templateUrl: './aiSettingsTab.component.pug',
})
export class AiSettingsTabComponent {
    registry = AI_CLI_REGISTRY
    extraPathsText: string

    constructor (
        public config: ConfigService,
        public scanner: CliScannerService,
    ) {
        this.extraPathsText = (config.store.aiCli.scanner.extraPaths as string[]).join('\n')
    }

    versionFor (entry: AiCliRegistryEntry): string|null {
        return this.scanner.scanResults.find(x => x.entry.id === entry.id)?.version ?? null
    }

    isDetected (entry: AiCliRegistryEntry): boolean {
        return this.scanner.scanResults.some(x => x.entry.id === entry.id)
    }

    isEnabled (entry: AiCliRegistryEntry): boolean {
        return !this.config.store.aiCli.scanner.hidden.includes(entry.id)
    }

    setEnabled (entry: AiCliRegistryEntry, enabled: boolean): void {
        const hidden = (this.config.store.aiCli.scanner.hidden as string[]).filter(x => x !== entry.id)
        if (!enabled) {
            hidden.push(entry.id)
        }
        this.config.store.aiCli.scanner.hidden = hidden
        this.config.save()
        this.scanner.scan()
    }

    saveExtraPaths (): void {
        this.config.store.aiCli.scanner.extraPaths = this.extraPathsText
            .split('\n')
            .map(x => x.trim())
            .filter(x => x)
        this.config.save()
        this.scanner.scan()
    }

    rescan (): void {
        this.scanner.scan()
    }
}
