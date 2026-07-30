/**
 * Kimi Code lifecycle hooks → AiEvent translation + temporary home helpers.
 *
 * Hooks live only in `$KIMI_CODE_HOME/config.toml`. Vibby injects a per-session
 * temp home (user config + [[hooks]]) instead of mutating the permanent file.
 */
import { AiEvent } from './events'
import { quoteSh } from './paths'
import { appendWslenv } from './runtimeTargets'

export const KIMI_CODE_HOME_ENV = 'KIMI_CODE_HOME'
export const KIMI_HOOK_SESSION_ENV = 'VIBBY_KIMI_HOOK_SESSION'
export const KIMI_HOOK_TEMP_ENV = 'VIBBY_KIMI_HOOK_TEMP'
export const KIMI_TEMP_DIR_PREFIX = 'vibby-kimi-'
export const KIMI_DROP_DIR_NAME = 'drop'

export const KIMI_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'PermissionResult',
    'Stop',
    'StopFailure',
    'Interrupt',
    'SessionEnd',
    'Notification',
    'SubagentStart',
    'SubagentStop',
] as const

export interface KimiHookRecovery {
    sessionId: string
    tempName: string
}

const LINKED_DIRS = [
    'credentials',
    'sessions',
    'user-history',
    'logs',
    'telemetry',
    'updates',
] as const

const COPIED_FILES = [
    'device_id',
    'tui.toml',
    'workspaces.json',
    'session_index.jsonl',
] as const

export function kimiLinkedDirs (): readonly string[] {
    return LINKED_DIRS
}

export function kimiCopiedFiles (): readonly string[] {
    return COPIED_FILES
}

export function kimiHookRecovery (
    env: Record<string, string|undefined>,
): KimiHookRecovery|null {
    const sessionId = env[KIMI_HOOK_SESSION_ENV] ?? ''
    const tempName = env[KIMI_HOOK_TEMP_ENV] ?? ''
    if (
        !/^[\w-]{1,64}$/.test(sessionId) ||
        !new RegExp(`^${KIMI_TEMP_DIR_PREFIX}[A-Za-z0-9]{6}$`).test(tempName)
    ) {
        return null
    }
    return { sessionId, tempName }
}

export function withoutStaleKimiHookEnv (
    env: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) =>
            key !== KIMI_CODE_HOME_ENV &&
            key !== KIMI_HOOK_SESSION_ENV &&
            key !== KIMI_HOOK_TEMP_ENV,
        ),
    )
}

/** Escape a value for a TOML basic string (double-quoted). */
export function escapeTomlBasicString (value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
}

/**
 * Append Vibby hook rules to an existing user config (or start from hooks only).
 * Extra fields are rejected by Kimi, so each [[hooks]] entry stays to the four
 * documented keys.
 */
export function buildKimiConfigToml (userConfig: string, hookCommand: string): string {
    const base = userConfig.replace(/\s+$/, '')
    const command = escapeTomlBasicString(hookCommand)
    const blocks = KIMI_HOOK_EVENTS.map(event => [
        '[[hooks]]',
        `event = "${event}"`,
        `command = "${command}"`,
        'timeout = 5',
    ].join('\n')).join('\n\n')
    return base ? `${base}\n\n${blocks}\n` : `${blocks}\n`
}

/** curl fallback when the WSL file-drop lane is unavailable. */
export function kimiCurlHookCommand (curlPath: string, endpoint: string): string {
    return `${quoteSh(curlPath)} -s -m 3 --data-binary @- ${quoteSh(endpoint)}`
}

export function kimiHookEnvironment (
    home: string,
    sessionId: string,
    tempName: string,
    existingEnv: Record<string, string> = {},
    options: { wsl?: boolean } = {},
): Record<string, string> {
    const env: Record<string, string> = {
        ...existingEnv,
        [KIMI_CODE_HOME_ENV]: home,
        [KIMI_HOOK_SESSION_ENV]: sessionId,
        [KIMI_HOOK_TEMP_ENV]: tempName,
    }
    if (options.wsl) {
        const inheritedWslenv = Object.prototype.hasOwnProperty.call(existingEnv, 'WSLENV')
            ? existingEnv.WSLENV
            : process.env.WSLENV
        env.WSLENV = appendWslenv(inheritedWslenv, [
            KIMI_CODE_HOME_ENV,
            KIMI_HOOK_SESSION_ENV,
            KIMI_HOOK_TEMP_ENV,
        ])
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
 * Kimi's UserPromptSubmit carries `prompt` as ContentPart[]
 * (`[{ type: "text", text: "..." }]`), not a plain string.
 */
export function contentPartsText (value: unknown): string {
    if (typeof value === 'string') {
        return value
    }
    if (Array.isArray(value)) {
        return value
            .map(part => {
                if (typeof part === 'string') {
                    return part
                }
                const item = record(part)
                return text(item['text'] ?? item['content'])
            })
            .filter(Boolean)
            .join(' ')
            .trim()
    }
    const wrapped = record(value)
    if (wrapped['text'] || wrapped['content']) {
        return text(wrapped['text'] ?? wrapped['content'])
    }
    return ''
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

export function summaryForKimiToolCall (
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
): string {
    const input = toolInput ?? {}
    const name = toolName || text(input['name'])
    switch (name) {
        case 'Edit':
        case 'MultiEdit':
        case 'Write':
        case 'NotebookEdit':
            return `edit: ${basename(String(input['file_path'] ?? input['notebook_path'] ?? input['path'] ?? ''))}`
        case 'Read':
            return `read: ${basename(String(input['file_path'] ?? input['path'] ?? ''))}`
        case 'Bash':
        case 'Shell':
            return `command: ${commandName(input['command'])}`
        case 'Grep':
        case 'Glob':
            return 'search'
        case 'Task':
        case 'Agent':
            return 'agent'
        case 'WebFetch':
        case 'WebSearch':
            return 'web'
        default:
            return name ? name.toLowerCase() : 'tool'
    }
}

/**
 * Returns null for payloads we cannot make sense of or deliberately ignore.
 */
export function translateKimiHook (sessionId: string, payload: unknown, ts: number): AiEvent | null {
    if (!payload || typeof payload !== 'object') {
        return null
    }
    const p = record(payload)
    const base = { sessionId, ts, confidence: 'high' as const }
    const toolName = text(p['tool_name'])
    const toolInput = record(p['tool_input'])
    const tool = summaryForKimiToolCall(toolName, toolInput)
    const hook = text(p['hook_event_name'])

    switch (hook) {
        case 'SessionStart':
            return { ...base, kind: 'session-started', summary: 'ready' }
        case 'UserPromptSubmit':
            return {
                ...base,
                kind: 'prompt-submitted',
                summary: `user: ${contentPartsText(p['prompt'] ?? p['user_prompt'] ?? p['matcher_value'])}`,
            }
        case 'PreToolUse':
            return { ...base, kind: 'tool-call', summary: tool }
        case 'PostToolUse':
            return { ...base, kind: 'tool-result', summary: `${tool} done` }
        case 'PostToolUseFailure':
            return {
                ...base,
                kind: 'tool-result',
                summary: `${tool} failed`,
            }
        case 'PermissionRequest':
            return {
                ...base,
                kind: 'permission-request',
                summary: toolName ? `approve: ${toolName}` : 'approval required',
            }
        case 'PermissionResult':
            return { ...base, kind: 'request-resolved', summary: 'permission resolved' }
        case 'Stop':
            return { ...base, kind: 'turn-completed', summary: 'done' }
        case 'Interrupt':
            return {
                ...base,
                kind: 'turn-completed',
                summary: text(p['reason']) || 'interrupted',
                projectedState: 'idle',
            }
        case 'StopFailure':
            return {
                ...base,
                kind: 'session-error',
                summary: `error: ${text(p['error']) || text(p['reason']) || 'unknown'}`,
            }
        case 'SessionEnd':
            return {
                ...base,
                kind: 'session-ended',
                summary: `ended: ${text(p['reason']) || 'exit'}`,
                projectedState: 'idle',
            }
        case 'SubagentStart':
            return { ...base, kind: 'tool-call', summary: 'agent' }
        case 'SubagentStop':
            return { ...base, kind: 'tool-result', summary: 'agent done' }
        case 'Notification': {
            const message = text(p['message'])
            const type = text(p['notification_type'] ?? p['type'])
            if (type === 'task.completed' || /task\.completed/i.test(type)) {
                return { ...base, kind: 'turn-completed', summary: message || 'task done' }
            }
            if (/permission|approv/i.test(type) || /permission|approv/i.test(message)) {
                return { ...base, kind: 'permission-request', summary: message || 'permission needed' }
            }
            if (/input|question/i.test(type) || /input|question/i.test(message)) {
                return { ...base, kind: 'question-request', summary: message || 'input needed' }
            }
            // Unknown notifications are ignored — do not invent a thinking row
            // that would overwrite the user prompt caption.
            return null
        }
        default:
            return null
    }
}
