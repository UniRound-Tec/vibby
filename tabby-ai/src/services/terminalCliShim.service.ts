import * as fs from 'fs'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { TerminalTabComponent } from 'tabby-local'

import { DetectedCli } from '../api'
import { isGeneratedPath } from '../paths'

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
    ): TerminalCliShimInstallation {
        fs.mkdirSync(directory, { recursive: true })

        for (const binary of detected.entry.binaries) {
            const wrapperPath = path.join(directory, WINDOWS ? `${binary}.cmd` : binary)
            fs.writeFileSync(
                wrapperPath,
                WINDOWS
                    ? this.windowsWrapper(detected, injectedArgs)
                    : this.posixWrapper(detected, injectedArgs),
                { mode: 0o700 },
            )
        }

        const previous = tab.profile.options.pathPrefix ?? []
        tab.profile.options.pathPrefix = [
            directory,
            ...previous.filter(item => !isGeneratedPath(item)),
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

    private windowsWrapper (detected: DetectedCli, args: string[]): string {
        const command = this.quoteCmd(detected.command)
        const forwarded = args.map(arg => this.quoteCmd(arg)).join(' ')
        const invocation = detected.launcher === 'cmd'
            ? `call ${command} ${forwarded} %*`
            : detected.launcher === 'ps1'
                ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${command} ${forwarded} %*`
                : `${command} ${forwarded} %*`
        return `@echo off\r\n${invocation.trim()}\r\n`
    }

    private posixWrapper (detected: DetectedCli, args: string[]): string {
        const invocation = [
            this.quoteSh(detected.command),
            ...args.map(arg => this.quoteSh(arg)),
            '"$@"',
        ].join(' ')
        return `#!/bin/sh\nexec ${invocation}\n`
    }

    /**
     * `%%` as well as the quotes: cmd expands `%VAR%` when it runs the batch
     * file, so a path or argument containing a percent sign would arrive
     * mangled — or empty — without doubling it.
     */
    private quoteCmd (value: string): string {
        return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`
    }

    private quoteSh (value: string): string {
        return `'${value.replace(/'/g, `'\\''`)}'`
    }
}
