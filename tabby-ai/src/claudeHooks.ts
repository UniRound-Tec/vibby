/**
 * Claude Code hook payload → AiEvent translation (docs/06-m2-plan.md §1).
 * Pure module — unit-tested alongside events.ts.
 *
 * Summary verbs stay English regardless of UI locale (design §2.5);
 * free-text parts follow the session content.
 */
import { AiEvent } from './events'

function basename (p: string): string {
    const flat = String(p)
    const i = Math.max(flat.lastIndexOf('/'), flat.lastIndexOf('\\'))
    return i >= 0 ? flat.slice(i + 1) : flat
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
            return `bash: ${String(input['command'] ?? '')}`
        case 'Grep':
            return `grep: ${String(input['pattern'] ?? '')}`
        case 'Glob':
            return `glob: ${String(input['pattern'] ?? '')}`
        case 'Task':
        case 'Agent':
            return `agent: ${String(input['description'] ?? '')}`
        case 'WebFetch':
        case 'WebSearch':
            return `web: ${String(input['url'] ?? input['query'] ?? '')}`
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
    const base = { sessionId, ts, confidence: 'high' as const, raw: payload }

    switch (p['hook_event_name']) {
        case 'SessionStart':
            return { ...base, kind: 'session-started', summary: 'ready' }
        case 'UserPromptSubmit':
            return { ...base, kind: 'prompt-submitted', summary: `user: ${String(p['prompt'] ?? '')}` }
        case 'PreToolUse':
            return {
                ...base,
                kind: 'tool-call',
                summary: summaryForToolCall(String(p['tool_name'] ?? ''), p['tool_input'] as Record<string, unknown> | undefined),
            }
        case 'Notification': {
            const message = String(p['message'] ?? '')
            return {
                ...base,
                kind: /permission/i.test(message) ? 'permission-request' : 'notification',
                summary: message || 'needs your input',
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
