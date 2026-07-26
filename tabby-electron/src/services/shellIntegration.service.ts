import * as path from 'path'
import * as fs from 'mz/fs'
import { execFile } from 'mz/child_process'
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

/* eslint-disable block-scoped-var */

try {
    var wnr = require('windows-native-registry') // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch (_) { }

@Injectable({ providedIn: 'root' })
export class ShellIntegrationService {
    private automatorWorkflows = ['Open Vibby here.workflow', 'Paste path into Vibby.workflow']
    private legacyAutomatorWorkflows = ['Open Tabby here.workflow', 'Paste path into Tabby.workflow']
    private automatorWorkflowsLocation: string
    private automatorWorkflowsDestination: string
    private registryKeys = [
        {
            path: 'Software\\Classes\\Directory\\Background\\shell\\Vibby',
            value: 'Open Vibby here',
            command: 'open "%V"',
        },
        {
            path: 'SOFTWARE\\Classes\\Directory\\shell\\Vibby',
            value: 'Open Vibby here',
            command: 'open "%V"',
        },
        {
            path: 'Software\\Classes\\*\\shell\\Vibby',
            value: 'Paste path into Vibby',
            command: 'paste "%V"',
        },
    ]

    /** Keys written by earlier Tabby-branded builds, removed on install */
    private legacyRegistryKeys = [
        'Software\\Classes\\Directory\\Background\\shell\\Tabby',
        'SOFTWARE\\Classes\\Directory\\shell\\Tabby',
        'Software\\Classes\\*\\shell\\Tabby',
        'Software\\Classes\\Directory\\Background\\shell\\Open Tabby here',
        'Software\\Classes\\*\\shell\\Paste path into Tabby',
    ]

    private constructor (
        private electron: ElectronService,
        private hostApp: HostAppService,
    ) {
        if (this.hostApp.platform === Platform.macOS) {
            this.automatorWorkflowsLocation = path.join(
                path.dirname(path.dirname(this.electron.app.getPath('exe'))),
                'Resources',
                'extras',
                'automator-workflows',
            )
            this.automatorWorkflowsDestination = path.join(process.env.HOME!, 'Library', 'Services')
        }
        this.updatePaths()
    }

    async isInstalled (): Promise<boolean> {
        if (this.hostApp.platform === Platform.macOS) {
            return fs.exists(path.join(this.automatorWorkflowsDestination, this.automatorWorkflows[0]))
        } else if (this.hostApp.platform === Platform.Windows) {
            return !!wnr.getRegistryKey(wnr.HK.CU, this.registryKeys[0].path)
        }
        return true
    }

    async install (): Promise<void> {
        const exe: string = process.env.PORTABLE_EXECUTABLE_FILE ?? this.electron.app.getPath('exe')
        if (this.hostApp.platform === Platform.macOS) {
            for (const wf of this.automatorWorkflows) {
                await execFile('cp', ['-r', path.join(this.automatorWorkflowsLocation, wf), this.automatorWorkflowsDestination])
            }
        } else if (this.hostApp.platform === Platform.Windows) {
            for (const registryKey of this.registryKeys) {
                wnr.createRegistryKey(wnr.HK.CU, registryKey.path)
                wnr.createRegistryKey(wnr.HK.CU, registryKey.path + '\\command')
                wnr.setRegistryValue(wnr.HK.CU, registryKey.path, '', wnr.REG.SZ, registryKey.value)
                wnr.setRegistryValue(wnr.HK.CU, registryKey.path, 'Icon', wnr.REG.SZ, exe)
                wnr.setRegistryValue(wnr.HK.CU, registryKey.path + '\\command', '', wnr.REG.SZ, exe + ' ' + registryKey.command)
            }

            for (const legacyKey of this.legacyRegistryKeys) {
                if (wnr.getRegistryKey(wnr.HK.CU, legacyKey)) {
                    wnr.deleteRegistryKey(wnr.HK.CU, legacyKey)
                }
            }
        }
    }

    async remove (): Promise<void> {
        if (this.hostApp.platform === Platform.macOS) {
            for (const wf of [...this.automatorWorkflows, ...this.legacyAutomatorWorkflows]) {
                await execFile('rm', ['-rf', path.join(this.automatorWorkflowsDestination, wf)])
            }
        } else if (this.hostApp.platform === Platform.Windows) {
            for (const registryKey of this.registryKeys) {
                wnr.deleteRegistryKey(wnr.HK.CU, registryKey.path)
            }
        }
    }

    private async updatePaths (): Promise<void> {
        // Update paths in case of an update. A leftover Tabby-branded key
        // also counts as installed — installing over it migrates the user
        // to the Vibby keys and cleans the old ones up.
        if (this.hostApp.platform === Platform.Windows) {
            const hasLegacyKey = this.legacyRegistryKeys.some(key => !!wnr.getRegistryKey(wnr.HK.CU, key))
            if (await this.isInstalled() || hasLegacyKey) {
                await this.install()
            }
        }
    }
}
