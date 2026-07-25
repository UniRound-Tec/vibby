import * as fs from 'fs/promises'
import * as which from 'which'
import { Injectable } from '@angular/core'
import { HostAppService, ConfigService, Platform } from 'tabby-core'

import { Shell } from 'tabby-local'
import { WindowsBaseShellProvider } from './windowsBase'

/* eslint-disable block-scoped-var */

try {
    var wnr = require('windows-native-registry') // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch { }

/** @hidden */
@Injectable()
export class PowerShellCoreShellProvider extends WindowsBaseShellProvider {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        hostApp: HostAppService,
        config: ConfigService,
    ) {
        super(hostApp, config)
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        const pwshPath = await this.getPowerShellPath()

        if (!pwshPath) {
            return []
        }

        return [{
            id: 'powershell-core',
            name: 'PowerShell 7',
            command: pwshPath,
            args: ['-nologo'],
            icon: require('../icons/powershell-core.svg'),
            env: this.getEnvironment(),
            shellType: 'powershell',
        }]
    }

    private async getPowerShellPath (): Promise<string | null> {
        const candidates: (string | null)[] = []

        try {
            candidates.push(wnr?.getRegistryValue(
                wnr.HK.LM,
                'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe',
                '',
            ) ?? null)
        } catch { }

        if (process.env.ProgramFiles) {
            candidates.push(`${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`)
        }
        if (process.env['ProgramFiles(x86)']) {
            candidates.push(`${process.env['ProgramFiles(x86)']}\\PowerShell\\7\\pwsh.exe`)
        }
        if (process.env.USERPROFILE) {
            // Microsoft Store installs expose pwsh through an App Execution Alias.
            // fs.stat() returns EACCES for this reparse point, but access() correctly
            // verifies that it can be launched.
            candidates.push(`${process.env.USERPROFILE}\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe`)
        }

        candidates.push(await which('pwsh.exe', { nothrow: true }))

        for (const candidate of candidates) {
            if (!candidate) {
                continue
            }
            try {
                await fs.access(candidate)
                return candidate
            } catch { }
        }

        return null
    }
}
