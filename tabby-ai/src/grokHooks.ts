/**
 * Grok Build lifecycle hooks → AiEvent translation + hook-bridge helpers.
 *
 * Unlike the other adapters, Vibby does not shadow `$GROK_HOME`: grok's home
 * carries the credential file it rewrites on token refresh, the managed
 * install `bin/` + `downloads/` pair, the plugin marketplace cache and the
 * worktree database, and `18-sandbox.md` refuses to start under a symlinked
 * `$GROK_HOME` outright. Grok instead merges hooks from several sources, and
 * `~/.grok/hooks/*.json` is always trusted — so Vibby installs one permanent,
 * idempotent bridge there and scopes it per session with environment
 * variables injected at launch. Sessions Vibby did not launch leave those
 * variables unset and the bridge script exits before reading stdin.
 *
 * The generated JSON deliberately contains no `$`: the shipped docs describe
 * `${VAR}` expansion in `command`/`url` but point at an external reference for
 * whether it happens at load time or run time, so the bridge script reads the
 * variables from its own inherited environment instead, which is unambiguous.
 *
 * Payload shapes below were captured from grok 0.2.114 rather than inferred:
 * keys are camelCase, `hookEventName` values are snake_case, and the tool
 * vocabulary is grok's own (`run_terminal_command`, `read_file`, …), not
 * Claude's.
 */
import { AiEvent } from './events'
import { appendWslenv } from './runtimeTargets'

export const GROK_HOOK_SESSION_ENV = 'VIBBY_GROK_SESSION'
export const GROK_HOOK_DROP_ENV = 'VIBBY_GROK_DROP'
export const GROK_HOOK_ENDPOINT_ENV = 'VIBBY_GROK_ENDPOINT'
export const GROK_TEMP_DIR_PREFIX = 'vibby-grok-'
export const GROK_DROP_DIR_NAME = 'drop'

/** Where the permanent bridge lives, relative to the grok home. */
export const GROK_HOOK_DIR_NAME = 'hooks'
export const GROK_HOOK_CONFIG_NAME = 'vibby.json'
export const GROK_HOOK_SCRIPT_NAME = 'vibby-hook.sh'
export const GROK_HOOK_SCRIPT_CMD_NAME = 'vibby-hook.cmd'
export const GROK_HOOK_SCRIPT_PS1_NAME = 'vibby-hook.ps1'

/**
 * Bumped whenever the generated bridge changes. It rides in a comment inside
 * the script so `ensureHookBridge` can reinstall on upgrade by plain content
 * comparison — no separate stamp file to keep in sync.
 */
export const GROK_HOOK_BRIDGE_VERSION = 2

/**
 * Every passive event grok exposes. `PreToolUse` and `Stop` can also block,
 * but the bridge never writes a decision to stdout, so all fourteen are
 * observation-only here.
 */
export const GROK_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionDenied',
    'Stop',
    'StopFailure',
    'Notification',
    'SubagentStart',
    'SubagentStop',
    'PreCompact',
    'PostCompact',
    'SessionEnd',
] as const

export type GrokHookEvent = typeof GROK_HOOK_EVENTS[number]

/**
 * Hook timeout, seconds. Grok defaults `Stop`/`SubagentStop` to 600 because
 * those are commonly build gates; the bridge only forwards a payload, so it
 * pins every event to the short timeout instead. Hooks fail open, and a slow
 * one would stall the user's turn.
 */
const HOOK_TIMEOUT_SECONDS = 5

export interface GrokHookRecovery {
    sessionId: string
}

export interface GrokHookTransport {
    /** Directory the bridge drops payload files into, or null for the HTTP lane */
    dropDir?: string | null
    /** Loopback ingress URL, used when the drop lane is unavailable */
    endpoint?: string | null
}

export function grokHookRecovery (
    env: Record<string, string|undefined>,
): GrokHookRecovery|null {
    const sessionId = env[GROK_HOOK_SESSION_ENV] ?? ''
    if (!/^[\w-]{1,64}$/.test(sessionId)) {
        return null
    }
    return { sessionId }
}

export function withoutStaleGrokHookEnv (
    env: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) =>
            key !== GROK_HOOK_SESSION_ENV &&
            key !== GROK_HOOK_DROP_ENV &&
            key !== GROK_HOOK_ENDPOINT_ENV,
        ),
    )
}

/**
 * The permanent hook file. One matcher-less group per event, every one of them
 * pointing at the same bridge script by absolute path.
 */
export function buildGrokHookConfig (scriptPath: string): string {
    const hooks: Record<string, unknown> = {}
    for (const event of GROK_HOOK_EVENTS) {
        hooks[event] = [{
            hooks: [{
                type: 'command',
                command: scriptPath,
                timeout: HOOK_TIMEOUT_SECONDS,
            }],
        }]
    }
    return JSON.stringify({ hooks }, null, 2) + '\n'
}

/**
 * POSIX bridge (Linux, macOS and every WSL distro).
 *
 * The drop filename has to satisfy wslHookBridge's DROP_FILE_RE
 * (`<session>.<6 alnum>.json`), and the rename is what publishes it: the
 * poller only picks up `*.json`, so a payload still streaming through `cat`
 * can never be read half-written.
 */
export function buildGrokHookScript (): string {
    return [
        '#!/bin/sh',
        `# Vibby ↔ Grok Build hook bridge (v${GROK_HOOK_BRIDGE_VERSION}) — installed by Vibby.`,
        '#',
        '# Safe to delete: grok sessions Vibby did not launch leave the variables',
        '# below unset, so this exits before reading stdin and changes nothing.',
        `[ -n "$${GROK_HOOK_SESSION_ENV}" ] || exit 0`,
        `if [ -n "$${GROK_HOOK_DROP_ENV}" ]; then`,
        `    f=$(mktemp "$${GROK_HOOK_DROP_ENV}/$${GROK_HOOK_SESSION_ENV}.XXXXXX") || exit 0`,
        '    cat > "$f"',
        '    mv "$f" "$f.json"',
        '    exit 0',
        'fi',
        `[ -n "$${GROK_HOOK_ENDPOINT_ENV}" ] || exit 0`,
        `curl -s -m 3 --data-binary @- "$${GROK_HOOK_ENDPOINT_ENV}" >/dev/null 2>&1`,
        'exit 0',
        '',
    ].join('\n')
}

/**
 * Native Windows bridge. Everything past the guard is delegated to PowerShell
 * because cmd cannot write stdin to a uniquely named file on its own.
 */
export function buildGrokHookScriptCmd (): string {
    return [
        '@echo off',
        `rem Vibby - Grok Build hook bridge (v${GROK_HOOK_BRIDGE_VERSION}) - installed by Vibby.`,
        'rem Safe to delete: sessions Vibby did not launch leave the guard variable',
        'rem unset, so this exits before reading stdin and changes nothing.',
        `if "%${GROK_HOOK_SESSION_ENV}%"=="" exit /b 0`,
        `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${GROK_HOOK_SCRIPT_PS1_NAME}"`,
        'exit /b 0',
        '',
    ].join('\r\n')
}

/**
 * Windows drop/POST half of the bridge, invoked by the .cmd above.
 *
 * The payload is moved as raw bytes and never decoded. `[Console]::In` would
 * decode stdin with the console code page, and grok spawns hooks under the
 * system default — so on a CP936 machine a `你好` prompt reached the rail as
 * `浣犲ソ` (its UTF-8 bytes read as GBK).
 */
export function buildGrokHookScriptPs1 (): string {
    return [
        `# Vibby - Grok Build hook bridge (v${GROK_HOOK_BRIDGE_VERSION}) - installed by Vibby.`,
        `$session = $env:${GROK_HOOK_SESSION_ENV}`,
        'if (-not $session) { exit 0 }',
        '$stdin = [Console]::OpenStandardInput()',
        '$buffer = New-Object IO.MemoryStream',
        '$stdin.CopyTo($buffer)',
        '$payload = $buffer.ToArray()',
        `$drop = $env:${GROK_HOOK_DROP_ENV}`,
        'if ($drop) {',
        '    $n = [IO.Path]::GetRandomFileName().Replace(\'.\',\'\').Substring(0,6)',
        '    $f = [IO.Path]::Combine($drop, $session + \'.\' + $n)',
        '    [IO.File]::WriteAllBytes($f, $payload)',
        '    [IO.File]::Move($f, $f + \'.json\')',
        '    exit 0',
        '}',
        `$endpoint = $env:${GROK_HOOK_ENDPOINT_ENV}`,
        'if (-not $endpoint) { exit 0 }',
        'try {',
        '    Invoke-RestMethod -Method Post -Uri $endpoint -Body $payload -ContentType \'application/json\' -TimeoutSec 3 | Out-Null',
        '} catch { }',
        'exit 0',
        '',
    ].join('\r\n')
}

export function grokHookEnvironment (
    sessionId: string,
    transport: GrokHookTransport,
    existingEnv: Record<string, string> = {},
    options: { wsl?: boolean } = {},
): Record<string, string> {
    const env: Record<string, string> = {
        ...existingEnv,
        [GROK_HOOK_SESSION_ENV]: sessionId,
    }
    const injected = [GROK_HOOK_SESSION_ENV]
    if (transport.dropDir) {
        env[GROK_HOOK_DROP_ENV] = transport.dropDir
        injected.push(GROK_HOOK_DROP_ENV)
    } else if (transport.endpoint) {
        env[GROK_HOOK_ENDPOINT_ENV] = transport.endpoint
        injected.push(GROK_HOOK_ENDPOINT_ENV)
    }
    if (options.wsl) {
        env.WSLENV = appendWslenv(existingEnv.WSLENV ?? process.env.WSLENV, injected)
    }
    return env
}

function record (value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function text (value: unknown): string {
    return typeof value === 'string' ? value : ''
}

/**
 * Grok wraps the submitted prompt in `<user_query>` tags before handing it to
 * the hook. Showing those in the rail would waste most of the 48-char budget.
 */
export function grokPromptText (value: unknown): string {
    const raw = text(value)
    if (!raw) {
        return ''
    }
    const tagged = /<user_query>([\s\S]*?)<\/user_query>/.exec(raw)
    return (tagged ? tagged[1] : raw).replace(/\s+/g, ' ').trim()
}

function basename (p: string): string {
    const flat = String(p)
    const i = Math.max(flat.lastIndexOf('/'), flat.lastIndexOf('\\'))
    return i >= 0 ? flat.slice(i + 1) : flat
}

function commandName (value: unknown): string {
    const command = String(value ?? '').trim()
    const first = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command)?.slice(1).find(Boolean) ?? ''
    return basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '') || 'command'
}

/** `read_file` uses `target_file`, not Claude's `file_path` — verified on 0.2.114. */
function filePath (input: Record<string, unknown>): string {
    return basename(String(
        input['target_file'] ?? input['file_path'] ?? input['path'] ?? input['notebook_path'] ?? '',
    ))
}

/**
 * Tool captions for grok's own vocabulary. MCP calls arrive fully qualified as
 * `server__tool`, which the default branch renders as `server: tool`.
 */
export function summaryForGrokToolCall (
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
): string {
    const input = toolInput ?? {}
    const name = toolName || text(input['name'])
    switch (name) {
        case 'run_terminal_command':
            return `command: ${commandName(input['command'])}`
        case 'read_file':
            return `read: ${filePath(input)}`
        case 'search_replace':
        case 'create_file':
            return `edit: ${filePath(input)}`
        case 'grep':
        case 'glob':
        case 'list_dir':
        case 'codebase_search':
            return 'search'
        case 'web_search':
        case 'web_fetch':
            return 'web'
        case 'spawn_subagent':
            return 'agent'
        case 'ask_user_question':
            return 'question'
        case 'todo_write':
            return 'todo'
        default: {
            if (!name) {
                return 'tool'
            }
            const mcp = name.split('__')
            return mcp.length > 1
                ? `${mcp[0]}: ${mcp.slice(1).join('__')}`
                : name.toLowerCase()
        }
    }
}

/**
 * `ask_user_question` is a tool call that parks the turn on the human, so it
 * has to reach the bus as `question-request` rather than `tool-call` —
 * otherwise the session reads as `working` while it waits.
 */
function toolCallEvent (
    base: { sessionId: string, ts: number, confidence: 'high' },
    toolName: string,
    summary: string,
): AiEvent {
    return toolName === 'ask_user_question'
        ? { ...base, kind: 'question-request', summary: 'question' }
        : { ...base, kind: 'tool-call', summary }
}

/**
 * Returns null for payloads we cannot make sense of or deliberately ignore.
 */
export function translateGrokHook (sessionId: string, payload: unknown, ts: number): AiEvent | null {
    if (!payload || typeof payload !== 'object') {
        return null
    }
    const p = record(payload)
    const base = { sessionId, ts, confidence: 'high' as const }
    const toolName = text(p['toolName'])
    const toolInput = record(p['toolInput'])
    const tool = summaryForGrokToolCall(toolName, toolInput)
    const hook = text(p['hookEventName'])

    switch (hook) {
        case 'session_start':
            return { ...base, kind: 'session-started', summary: 'ready' }
        case 'user_prompt_submit':
            return {
                ...base,
                kind: 'prompt-submitted',
                summary: `user: ${grokPromptText(p['prompt'])}`,
            }
        case 'pre_tool_use':
            return toolCallEvent(base, toolName, tool)
        case 'post_tool_use':
            return { ...base, kind: 'tool-result', summary: `${tool} done` }
        case 'post_tool_use_failure':
            return { ...base, kind: 'tool-result', summary: `${tool} failed` }
        case 'permission_denied':
            // The permission system already said no — the human is no longer
            // the bottleneck, so this resolves the request rather than raising
            // a new one.
            return {
                ...base,
                kind: 'request-resolved',
                summary: toolName ? `denied: ${toolName}` : 'permission denied',
            }
        case 'stop': {
            // A second, observation-only Stop fires at session end carrying
            // `channel_closed` or `shutdown`. Both land within milliseconds of
            // the real one, so without this filter every exit posts a phantom
            // "done" after the session has already ended.
            if (text(p['reason']) !== 'end_turn') {
                return null
            }
            return { ...base, kind: 'turn-completed', summary: 'done' }
        }
        case 'stop_failure':
            return {
                ...base,
                kind: 'session-error',
                summary: `error: ${text(p['error']) || text(p['errorDetails']) || 'unknown'}`,
            }
        case 'pre_compact':
            return { ...base, kind: 'tool-call', summary: 'compacting' }
        case 'post_compact':
            return { ...base, kind: 'tool-result', summary: 'compacted' }
        case 'subagent_start':
            return { ...base, kind: 'tool-call', summary: 'agent' }
        case 'subagent_stop':
            return { ...base, kind: 'tool-result', summary: 'agent done' }
        case 'session_end':
            return {
                ...base,
                kind: 'session-ended',
                summary: `ended: ${text(p['reason']) || 'exit'}`,
                projectedState: 'idle',
            }
        case 'notification': {
            const message = text(p['message'])
            const type = text(p['notificationType'] ?? p['type'])
            // Known types are matched exactly before any pattern runs: `ask`
            // is a substring of `t-ask-_complete`, so a loose /ask/ would route
            // the completion notification to the wrong state.
            switch (type) {
                // `permission_prompt` is the only attention signal grok emits —
                // there is no PreToolUse-style "permission requested" event, and
                // PermissionDenied fires only after the answer. Verified to fire
                // regardless of terminal focus (the `only_unfocused` knob belongs
                // to the separate [[ui.notifications.hooks]] surface).
                case 'permission_prompt':
                    return { ...base, kind: 'permission-request', summary: message || 'permission needed' }
                case 'turn_complete':
                case 'task_complete':
                    return { ...base, kind: 'turn-completed', summary: message || 'done' }
                case 'session_ready':
                    return { ...base, kind: 'session-started', summary: message || 'ready' }
                case 'agent_error':
                    return { ...base, kind: 'session-error', summary: message || 'error' }
            }
            // Fallbacks for variants this grok build does not emit yet.
            if (/permission|approv/i.test(type) || /permission|approv/i.test(message)) {
                return { ...base, kind: 'permission-request', summary: message || 'permission needed' }
            }
            if (/input_required|question|\bask\b/i.test(type) || /\binput\b|question/i.test(message)) {
                return { ...base, kind: 'question-request', summary: message || 'input needed' }
            }
            if (/error|fail/i.test(type)) {
                return { ...base, kind: 'session-error', summary: message || 'error' }
            }
            if (/complete|finished/i.test(type)) {
                return { ...base, kind: 'turn-completed', summary: message || 'done' }
            }
            if (/ready/i.test(type)) {
                return { ...base, kind: 'session-started', summary: message || 'ready' }
            }
            // Unknown notifications are ignored — do not invent a thinking row
            // that would overwrite the user prompt caption.
            return null
        }
        default:
            return null
    }
}
