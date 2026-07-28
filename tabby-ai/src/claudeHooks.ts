/**
 * Claude Code hook payload → AiEvent translation (docs/06-m2-plan.md §1).
 * Pure module — unit-tested alongside events.ts.
 *
 * Summary verbs stay English regardless of UI locale (design §2.5).
 *
 * The prompt is carried into the summary so the dashboard timeline says which
 * session was doing what; sanitizeEvent bounds it to one line. Command
 * arguments and raw hook payloads still stay out — a tool input can be a whole
 * file, and only the command's name is ever worth a row.
 */
import { AiEvent } from './events'

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

export function summaryForToolCall (toolName: string, toolInput: Record<string, unknown> | undefined): string {
    const input = toolInput ?? {}
    switch (toolName) {
        case 'Edit':
        case 'MultiEdit':
        case 'Write':
        case 'NotebookEdit':
            return `edit: ${basename(String(input['file_path'] ?? input['notebook_path'] ?? ''))}`
        case 'Read':
            return `read: ${basename(String(input['file_path'] ?? ''))}`
        case 'Bash':
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
            return toolName.toLowerCase()
    }
}

/**
 * Returns null for hook events we deliberately do not subscribe to
 * (v0 noise control) or payloads we cannot make sense of.
 */
export function translateClaudeHook (sessionId: string, payload: unknown, ts: number): AiEvent | null {
    if (typeof payload !== 'object' || payload === null) {
        return null
    }
    const p = payload as Record<string, unknown>
    const base = { sessionId, ts, confidence: 'high' as const }

    switch (p['hook_event_name']) {
        case 'SessionStart':
            return { ...base, kind: 'session-started', summary: 'ready' }
        case 'UserPromptSubmit':
            // clamped to one line by sanitizeEvent, so a long prompt is safe here
            return { ...base, kind: 'prompt-submitted', summary: `user: ${String(p['prompt'] ?? '')}` }
        case 'PreToolUse':
            return {
                ...base,
                kind: 'tool-call',
                summary: summaryForToolCall(String(p['tool_name'] ?? ''), p['tool_input'] as Record<string, unknown> | undefined),
            }
        case 'Notification': {
            const message = String(p['message'] ?? '')
            switch (p['notification_type']) {
                case 'idle_prompt':
                    return { ...base, kind: 'turn-completed', summary: message || 'idle' }
                case 'permission_prompt':
                    return { ...base, kind: 'permission-request', summary: message || 'permission needed' }
                case 'elicitation_dialog':
                    return { ...base, kind: 'question-request', summary: message || 'input needed' }
                case 'auth_success':
                case 'elicitation_complete':
                case 'elicitation_response':
                    return null
                default:
                    // Compatibility with Claude versions whose Notification
                    // payload predates notification_type.
                    return {
                        ...base,
                        kind: /permission/i.test(message) ? 'permission-request' : 'notification',
                        summary: message || 'needs your input',
                    }
            }
        }
        case 'Stop':
            return { ...base, kind: 'turn-completed', summary: 'done' }
        case 'SessionEnd':
            return { ...base, kind: 'session-ended', summary: `ended: ${String(p['reason'] ?? 'exit')}` }
        default:
            return null
    }
}
