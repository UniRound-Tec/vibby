import { AiEvent } from './events'

export const CODEX_HOOK_ENDPOINT_ENV = 'VIBBY_CODEX_HOOK_ENDPOINT'

export const CODEX_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'SubagentStart',
    'SubagentStop',
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
 * Session-scoped hook override. The commands stay byte-for-byte stable between
 * launches so Codex's hook trust hash does not churn with ports or session IDs.
 */
export function codexHookConfig (): string {
    const posix = `curl -s -m 3 --data-binary @- "$${CODEX_HOOK_ENDPOINT_ENV}"`
    const windows = [
        '$body=[Console]::In.ReadToEnd();',
        `Invoke-WebRequest -UseBasicParsing -Method Post -Uri $env:${CODEX_HOOK_ENDPOINT_ENV}`,
        '-ContentType \'application/json; charset=utf-8\' -Body $body -TimeoutSec 3 | Out-Null',
    ].join(' ')
    const handler = `[{ hooks = [{ type = "command", command = ${tomlString(posix)}, command_windows = ${tomlString(windows)}, timeout = 3 }] }]`
    return `hooks={ ${CODEX_HOOK_EVENTS.map(event => `${event} = ${handler}`).join(', ')} }`
}

/** Converts Codex's documented hook payloads without retaining sensitive raw data. */
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
            return { ...base, kind: 'prompt-submitted', summary: 'user' }
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
