import { AiEvent } from './events'
import { quoteSh } from './paths'
import { wslExecProgramIndex } from './runtimeTargets'

export const CODEX_HOOK_ENDPOINT_ENV = 'VIBBY_CODEX_HOOK_ENDPOINT'
export const CODEX_HOOK_DROP_DIR_ENV = 'VIBBY_CODEX_HOOK_DROP_DIR'
export const CODEX_HOOK_SESSION_ENV = 'VIBBY_CODEX_HOOK_SESSION_ID'
export const CODEX_WSL_PROFILE_INSTALLED_RECORD = '__VIBBY_WSL_CODEX_PROFILE_OK__'

/** Every event Codex ships (codex-rs/config/src/hook_config.rs) */
export const CODEX_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'SubagentStart',
    'SubagentStop',
    'PreCompact',
    'PostCompact',
    'Stop',
    'SessionEnd',
] as const

function text (value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function record (value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function basename (value: unknown): string {
    const path = text(value)
    const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return index >= 0 ? path.slice(index + 1) : path
}

/** Never expose command arguments: prompts and credentials often live there. */
function commandName (value: unknown): string {
    const command = text(value).trim()
    const first = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command)?.slice(1).find(Boolean) ?? ''
    return basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '') || 'command'
}

function toolSummary (toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
        case 'Bash':
            return `command: ${commandName(input['command'])}`
        case 'apply_patch':
        case 'Edit':
        case 'Write':
            return `edit: ${basename(input['file_path'] ?? input['path']) || 'files'}`
        case 'Agent':
        case 'spawn_agent':
            return 'agent'
        default:
            return `tool: ${toolName || 'working'}`
    }
}

function tomlString (value: string): string {
    return JSON.stringify(value)
}

/**
 * Codex layers `$CODEX_HOME/<name>.config.toml` over the user config when
 * launched with `-p <name>`. The name is fixed so the trust hash Codex records
 * for these hooks stays put across launches.
 */
export const CODEX_PROFILE_NAME = 'vibby'

/**
 * Injects Codex-only arguments without leaking them into the WSL launcher.
 * A WSL profile is `wsl.exe ... --exec [env PATH=...] <codex> <codex args>`,
 * so its insertion point is after the real executable rather than at the
 * beginning of argv.
 */
export function injectCodexLaunchArgs (
    args: string[],
    injected: string[],
    wsl: boolean,
): string[]|null {
    if (!wsl) {
        return [...injected, ...args]
    }
    const program = wslExecProgramIndex(args)
    if (program < 0) {
        return null
    }
    return [
        ...args.slice(0, program + 1),
        ...injected,
        ...args.slice(program + 1),
    ]
}

export function codexPosixHookCommand (): string {
    return [
        `if [ -n "\${${CODEX_HOOK_DROP_DIR_ENV}:-}" ] && [ -n "\${${CODEX_HOOK_SESSION_ENV}:-}" ]; then`,
        `f=$(mktemp "$${CODEX_HOOK_DROP_DIR_ENV}/$${CODEX_HOOK_SESSION_ENV}.XXXXXX")`,
        '&& cat > "$f" && mv "$f" "$f.json";',
        `else curl -s -m 3 --data-binary @- "$${CODEX_HOOK_ENDPOINT_ENV}"; fi`,
    ].join(' ')
}

/**
 * Hook handlers as a standalone profile document.
 *
 * Deliberately a file rather than an inline `-c hooks={...}` override. The
 * handler commands quote their endpoint, so the TOML carries `\"`, and the
 * generated .cmd shim escapes a literal quote as `""` without touching the
 * backslash in front of it — which desynchronises the Windows argument parser
 * and made Codex reject the whole table. Only a bare profile name crosses the
 * shim boundary now.
 *
 * The commands stay byte-for-byte stable between launches (the endpoint
 * arrives through the environment) so the trust hash does not churn with ports
 * or session IDs.
 */
export function codexHookProfile (): string {
    // Native POSIX sessions post to loopback. WSL sessions cannot depend on
    // loopback reaching the Windows host (NAT mode), so their launch exports a
    // mounted drop directory and session ID. mktemp + rename keeps the poller
    // from ever observing a partially written payload.
    const posix = codexPosixHookCommand()
    // Bytes, never text. [Console]::In decodes stdin with the console code page
    // and re-encodes on the way out, which mangles every non-ASCII payload —
    // Stop carries last_assistant_message, so any answer that is not plain
    // English arrived as broken JSON and was dropped, leaving the session stuck
    // on `working`. The POSIX branch never had this: curl --data-binary is
    // already a byte pipe.
    const windows = [
        '$i=[Console]::OpenStandardInput(); $m=New-Object IO.MemoryStream; $i.CopyTo($m);',
        `Invoke-WebRequest -UseBasicParsing -Method Post -Uri $env:${CODEX_HOOK_ENDPOINT_ENV}`,
        '-ContentType \'application/json; charset=utf-8\' -Body $m.ToArray() -TimeoutSec 3 | Out-Null',
    ].join(' ')
    const handler = `[{ hooks = [{ type = "command", command = ${tomlString(posix)}, command_windows = ${tomlString(windows)}, timeout = 3 }] }]`
    return `[hooks]\n${CODEX_HOOK_EVENTS.map(event => `${event} = ${handler}`).join('\n')}\n`
}

/** Installs the static managed profile in the home seen by WSL Codex. */
export function codexWslProfileInstallScript (): string {
    return [
        'd="${CODEX_HOME:-$HOME/.codex}"',
        'mkdir -p "$d" || exit 1',
        'umask 077',
        `printf %s ${quoteSh(codexHookProfile())} > "$d/${CODEX_PROFILE_NAME}.config.toml" || exit 1`,
        `printf '${CODEX_WSL_PROFILE_INSTALLED_RECORD}\\n'`,
    ].join('\n')
}

/**
 * Converts Codex's documented hook payloads. The prompt reaches the summary
 * (bounded by sanitizeEvent); tool inputs and raw payloads do not, since one of
 * those can be an entire file.
 */
export function translateCodexHook (
    sessionId: string,
    payload: unknown,
    ts: number,
): AiEvent|null {
    const value = record(payload)
    const event = text(value['hook_event_name'])
    const toolName = text(value['tool_name'])
    const toolInput = record(value['tool_input'])
    const base = { sessionId, ts, confidence: 'high' as const }

    switch (event) {
        case 'SessionStart':
            return { ...base, kind: 'session-started', summary: 'ready' }
        case 'UserPromptSubmit':
            // clamped to one line by sanitizeEvent, so a long prompt is safe here
            return { ...base, kind: 'prompt-submitted', summary: `user: ${text(value['prompt'])}` }
        case 'PreToolUse':
            return { ...base, kind: 'tool-call', summary: toolSummary(toolName, toolInput) }
        case 'PermissionRequest':
            return {
                ...base,
                kind: 'permission-request',
                summary: toolName ? `approve: ${toolName}` : 'approval required',
            }
        case 'PostToolUse':
            return { ...base, kind: 'tool-result', summary: toolSummary(toolName, toolInput) }
        case 'SubagentStart':
            return { ...base, kind: 'tool-call', summary: 'agent' }
        case 'SubagentStop':
            return { ...base, kind: 'tool-result', summary: 'agent done' }
        // Compaction is a long silent stretch mid-turn with no tool traffic to
        // keep the pane alive. Reported as work rather than `thinking`, which
        // stays reserved for the low-confidence scraper.
        case 'PreCompact':
            return { ...base, kind: 'tool-call', summary: 'compacting' }
        case 'PostCompact':
            return { ...base, kind: 'tool-result', summary: 'compacted' }
        case 'Stop':
            return { ...base, kind: 'turn-completed', summary: 'done' }
        case 'SessionEnd':
            return { ...base, kind: 'session-ended', summary: `ended: ${text(value['reason']) || 'other'}` }
        default:
            return null
    }
}

/**
 * Codex can emit PreToolUse again after its approval phase. Correlate those
 * lifecycle callbacks by tool_use_id so one logical tool appears once.
 */
export class CodexHookProjector {
    private startedTools = new Set<string>()
    private finishedTools = new Set<string>()
    private permissionTools = new Set<string>()

    constructor (private sessionId: string) {}

    apply (payload: unknown, ts: number): AiEvent|null {
        const value = record(payload)
        const hook = text(value['hook_event_name'])
        const toolId = text(value['tool_use_id'])

        if (toolId) {
            if (hook === 'PreToolUse') {
                if (this.startedTools.has(toolId)) {
                    return null
                }
                this.startedTools.add(toolId)
            } else if (hook === 'PostToolUse') {
                if (this.finishedTools.has(toolId)) {
                    return null
                }
                this.finishedTools.add(toolId)
            } else if (hook === 'PermissionRequest') {
                if (this.permissionTools.has(toolId)) {
                    return null
                }
                this.permissionTools.add(toolId)
            }
        }

        const event = translateCodexHook(this.sessionId, value, ts)
        if (hook === 'Stop' || hook === 'SessionEnd') {
            this.startedTools.clear()
            this.finishedTools.clear()
            this.permissionTools.clear()
        }
        return event
    }
}
