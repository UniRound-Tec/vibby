import * as fs from 'fs'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { TerminalTabComponent } from 'tabby-local'

import { DetectedCli } from '../api'
import { generatedPathOwnerPid, isGeneratedPath } from '../paths'
import { buildPosixCliShim, buildWindowsCliShim } from '../terminalCliShim'

const WINDOWS = process.platform === 'win32'

export interface TerminalCliShimInstallation {
    directory: string
    remove: () => void
}

/**
 * Installs a per-terminal command shim without touching the user's global
 * PATH or CLI configuration. Adapters provide only their injected arguments;
 * this service owns Windows/POSIX launch details and can be reused by every
 * CLI adapter.
 */
@Injectable({ providedIn: 'root' })
export class TerminalCliShimService {
    install (
        tab: TerminalTabComponent,
        detected: DetectedCli,
        directory: string,
        injectedArgs: string[],
        injectedEnv: Record<string, string> = {},
        passthroughSubcommands: string[] = [],
    ): TerminalCliShimInstallation {
        fs.mkdirSync(directory, { recursive: true })

        for (const binary of detected.entry.binaries) {
            const wrapperPath = path.join(directory, WINDOWS ? `${binary}.cmd` : binary)
            fs.writeFileSync(
                wrapperPath,
                WINDOWS
                    ? buildWindowsCliShim(detected, injectedArgs, injectedEnv, passthroughSubcommands)
                    : buildPosixCliShim(detected, injectedArgs, injectedEnv, passthroughSubcommands),
                { mode: 0o700 },
            )
        }

        const previous = tab.profile.options.pathPrefix ?? []
        tab.profile.options.pathPrefix = [
            directory,
            // Keep other adapters armed in this process, but never resurrect a
            // stale shim from a recovery token or crashed older instance.
            ...previous.filter(item =>
                !isGeneratedPath(item) ||
                generatedPathOwnerPid(item) === process.pid && fs.existsSync(item),
            ),
        ]

        return {
            directory,
            remove: () => {
                try {
                    fs.rmSync(directory, { recursive: true, force: true })
                } catch { /* already gone */ }
            },
        }
    }
}
