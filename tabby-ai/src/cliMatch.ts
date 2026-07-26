/**
 * Which registry CLI, if any, is running inside a terminal.
 *
 * Pure module — unit-tested alongside events.ts. The detector polls this for
 * every local pane, so it has to be both cheap and quiet: a false positive
 * drags an ordinary shell to the top of the rail and gives it a session card.
 */
import { AiCliRegistryEntry } from './api'

/** Extensions that make a command-line token an invocation rather than a word */
const EXECUTABLE_SUFFIX_RE = /\.(?:exe|cmd|bat|ps1|sh|js|mjs|cjs|py)$/i

/** The part of tabby-local's ChildProcess this module needs */
export interface MatchableProcess {
    command: string
    commandLine?: string
}

export function executableName (command: string): string {
    const flat = String(command)
    const i = Math.max(flat.lastIndexOf('/'), flat.lastIndexOf('\\'))
    const base = i >= 0 ? flat.slice(i + 1) : flat
    return base.replace(EXECUTABLE_SUFFIX_RE, '').toLowerCase()
}

export function commandTokens (commandLine: string): string[] {
    return commandLine.match(/"[^"]*"|'[^']*'|\S+/g)?.map(token => token.replace(/^["']|["']$/g, '')) ?? []
}

/**
 * A bare word is not evidence. `grep claude notes.md` and
 * `python train.py --model pi` both contain a token that matches a registry
 * binary name, and treating those as sessions is worse than missing one —
 * `pi` is two letters and collides with ordinary arguments constantly.
 *
 * So a token only counts when it is shaped like something that was invoked:
 * it carries a path, or an executable extension. A CLI started by plain name
 * is already caught by the process's own command, and one started through a
 * package entry point by its runtime marker.
 */
export function looksInvoked (token: string): boolean {
    return token.includes('/') || token.includes('\\') || EXECUTABLE_SUFFIX_RE.test(token)
}

export function matchCli (processes: MatchableProcess[], registry: AiCliRegistryEntry[]): string | null {
    for (const entry of registry) {
        const binaries = entry.binaries.map(binary => binary.toLowerCase())
        for (const proc of processes) {
            // ① the process is the binary
            if (binaries.includes(executableName(proc.command))) {
                return entry.id
            }
            const commandLine = proc.commandLine?.toLowerCase() ?? ''
            if (!commandLine) {
                continue
            }
            // ② a package marker in the command line — highest confidence, and
            //    the usual shape for a CLI installed as an npm entry point
            if (entry.runtimeMarkers?.some(marker => commandLine.includes(marker.toLowerCase()))) {
                return entry.id
            }
            // ③ an argument that is itself an invocation of the binary
            if (commandTokens(commandLine).some(token =>
                looksInvoked(token) && binaries.includes(executableName(token)),
            )) {
                return entry.id
            }
        }
    }
    return null
}
