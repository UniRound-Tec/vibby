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

/** Rooted or explicitly relative — the shapes a path being executed takes */
const PATHLIKE_RE = /^(?:[A-Za-z]:[\\/]|[\\/~]|\.{1,2}[\\/])/

/**
 * A bare word is not evidence. `grep claude notes.md` and
 * `python train.py --model pi` both contain a token that matches a registry
 * binary name, and treating those as sessions is worse than missing one —
 * `pi` is two letters and collides with ordinary arguments constantly.
 *
 * So a token only counts when it is shaped like something that was invoked:
 * a rooted path, or an executable extension. Merely containing a slash is
 * not enough — `rg @openai/codex docs` holds a package name whose basename
 * is a registry binary, but a package name is not a path to anything. A CLI
 * started by plain name is already caught by the process's own command, and
 * one started through a package entry point by its runtime marker.
 */
export function looksInvoked (token: string): boolean {
    return PATHLIKE_RE.test(token) || EXECUTABLE_SUFFIX_RE.test(token)
}

/**
 * Launchers whose arguments are scripts being run. A package marker inside an
 * argument only means something under one of these — `grep openhands-ai README`
 * and `rg @openai/codex docs` mention a marker without running anything.
 * Shells are deliberately absent: `bash -c "grep openhands-ai file"` carries the
 * whole inner command as a single argument token.
 */
function isRuntimeLauncher (token: string): boolean {
    const name = executableName(token)
    return ['node', 'nodejs', 'bun', 'deno', 'py'].includes(name) || name.startsWith('python')
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
            const tokens = commandTokens(commandLine)
            // ② a package marker in an executed position — the usual shape
            //    for a CLI installed as an npm/pipx entry point. Executed
            //    means argv[0] itself, or, under a script runtime, the
            //    script/module argument: the first token that is not a flag.
            //    Later arguments are data — `python train.py --dataset
            //    openhands_cli` must not become an OpenHands session — and anywhere
            //    else the marker is merely being talked about
            //    (`rg @openai/codex docs`).
            const markers = entry.runtimeMarkers?.map(marker => marker.toLowerCase()) ?? []
            if (markers.length > 0 && tokens.length > 0) {
                const candidates = [tokens[0]]
                if (isRuntimeLauncher(tokens[0])) {
                    const script = tokens.slice(1).find(token => !token.startsWith('-'))
                    if (script) {
                        candidates.push(script)
                    }
                }
                if (candidates.some(token => markers.some(marker => token.includes(marker)))) {
                    return entry.id
                }
            }
            // ③ an argument that is itself an invocation of the binary
            if (tokens.some(token =>
                looksInvoked(token) && binaries.includes(executableName(token)),
            )) {
                return entry.id
            }
        }
    }
    return null
}
