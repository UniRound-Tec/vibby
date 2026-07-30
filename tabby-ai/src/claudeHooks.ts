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

export const CLAUDE_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'PostToolBatch',
    'PermissionDenied',
    'Notification',
    'SubagentStart',
    'SubagentStop',
    'PreCompact',
    'PostCompact',
    'Elicitation',
    'ElicitationResult',
    'Stop',
    'StopFailure',
    'SessionEnd',
] as const

export const CLAUDE_HOOK_SESSION_ENV = 'VIBBY_CLAUDE_HOOK_SESSION'
export const CLAUDE_HOOK_TEMP_ENV = 'VIBBY_CLAUDE_HOOK_TEMP'

export interface ClaudeHookRecovery {
    sessionId: string
    tempName: string
}

export function claudeHookRecovery (
    env: Record<string, string|undefined>,
): ClaudeHookRecovery|null {
    const sessionId = env[CLAUDE_HOOK_SESSION_ENV] ?? ''
    const tempName = env[CLAUDE_HOOK_TEMP_ENV] ?? ''
    if (
        !/^[\w-]{1,64}$/.test(sessionId) ||
        !/^vibby-hooks-[A-Za-z0-9]{6}$/.test(tempName)
    ) {
        return null
    }
    return { sessionId, tempName }
}

/** Drop recovery markers copied by Duplicate so a fresh arm cannot steal the live sessionId. */
export function withoutStaleClaudeHookEnv (
    env: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) =>
            key !== CLAUDE_HOOK_SESSION_ENV &&
            key !== CLAUDE_HOOK_TEMP_ENV,
        ),
    )
}

function record (value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function text (value: unknown): string {
    return typeof value === 'string' ? value : ''
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
    if (!payload || typeof payload !== 'object') {
        return null
    }
    const p = record(payload)
    const base = { sessionId, ts, confidence: 'high' as const }
    const toolName = text(p['tool_name'])
    const toolInput = record(p['tool_input'])
    const tool = summaryForToolCall(toolName, toolInput)

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
                summary: tool,
            }
        case 'PermissionRequest':
            return {
                ...base,
                kind: 'permission-request',
                summary: toolName ? `approve: ${toolName}` : 'approval required',
            }
        case 'PostToolUse':
            return { ...base, kind: 'tool-result', summary: `${tool} done` }
        case 'PostToolUseFailure':
            return {
                ...base,
                kind: 'tool-result',
                summary: `${tool} ${p['is_interrupt'] === true ? 'interrupted' : 'failed'}`,
            }
        case 'PostToolBatch':
            return { ...base, kind: 'thinking', summary: 'thinking' }
        case 'PermissionDenied':
            return { ...base, kind: 'tool-result', summary: `${tool} denied` }
        case 'Notification': {
            const message = text(p['message'])
            switch (p['notification_type']) {
                case 'idle_prompt':
                    return { ...base, kind: 'turn-completed', summary: message || 'idle' }
                case 'permission_prompt':
                    return { ...base, kind: 'permission-request', summary: message || 'permission needed' }
                case 'elicitation_dialog':
                    return { ...base, kind: 'question-request', summary: message || 'input needed' }
                case 'elicitation_complete':
                case 'elicitation_response':
                    return { ...base, kind: 'request-resolved', summary: 'input received' }
                case 'agent_needs_input':
                    return { ...base, kind: 'question-request', summary: message || 'agent needs input' }
                case 'agent_completed':
                    return { ...base, kind: 'tool-result', summary: message || 'agent done' }
                case 'auth_success':
                    return null
                default:
                    // Compatibility with Claude versions whose Notification
                    // payload predates notification_type. Unknown future
                    // notifications are ignored instead of falsely paging the
                    // user.
                    if (/permission|approv/i.test(message)) {
                        return { ...base, kind: 'permission-request', summary: message }
                    }
                    if (/input|question|answer/i.test(message)) {
                        return { ...base, kind: 'question-request', summary: message }
                    }
                    return null
            }
        }
        case 'SubagentStart':
            return { ...base, kind: 'tool-call', summary: 'agent' }
        case 'SubagentStop':
            return { ...base, kind: 'tool-result', summary: 'agent done' }
        case 'PreCompact':
            return { ...base, kind: 'tool-call', summary: 'compacting' }
        case 'PostCompact':
            return { ...base, kind: 'tool-result', summary: 'compacted' }
        case 'Elicitation':
            return { ...base, kind: 'question-request', summary: text(p['message']) || 'input needed' }
        case 'ElicitationResult':
            return { ...base, kind: 'request-resolved', summary: 'input received' }
        case 'Stop':
            return { ...base, kind: 'turn-completed', summary: 'done' }
        case 'StopFailure':
            return {
                ...base,
                kind: 'session-error',
                summary: `error: ${text(p['error']) || 'unknown'}`,
            }
        case 'SessionEnd':
            return {
                ...base,
                kind: 'session-ended',
                summary: `ended: ${text(p['reason']) || 'exit'}`,
                projectedState: 'idle',
            }
        default:
            return null
    }
}

interface ActiveTool {
    key: string
    summary: string
    order: number
}

/**
 * Correlates Claude's tool lifecycle callbacks. Tool hooks can be concurrent,
 * duplicated by layered settings, or delivered together by the WSL file lane;
 * the UI must describe the remaining active work rather than whichever
 * callback happened to arrive last.
 */
export class ClaudeHookProjector {
    private activeTools = new Map<string, ActiveTool>()
    private startedTools = new Set<string>()
    private finishedTools = new Set<string>()
    private order = 0
    private anonymous = 0

    constructor (private sessionId: string) {}

    get hasActiveTools (): boolean {
        return this.activeTools.size > 0
    }

    apply (payload: unknown, ts: number): AiEvent|null {
        const value = record(payload)
        const hook = text(value['hook_event_name'])
        const toolId = text(value['tool_use_id'])
        const toolName = text(value['tool_name'])
        const toolSummary = summaryForToolCall(toolName, record(value['tool_input']))

        if (hook === 'SessionStart' || hook === 'UserPromptSubmit') {
            this.resetTurn()
        }

        if (hook === 'PreToolUse') {
            if (toolId && (this.startedTools.has(toolId) || this.finishedTools.has(toolId))) {
                return null
            }
            const key = toolId || `anonymous:${++this.anonymous}`
            this.startedTools.add(key)
            this.activeTools.set(key, { key, summary: toolSummary, order: ++this.order })
        } else if (hook === 'PostToolUse' || hook === 'PostToolUseFailure' || hook === 'PermissionDenied') {
            if (toolId && this.finishedTools.has(toolId)) {
                return null
            }
            this.finishTool(toolId, toolSummary)
        } else if (hook === 'SubagentStart') {
            const key = `agent:${text(value['agent_id']) || ++this.anonymous}`
            if (this.startedTools.has(key)) {
                return null
            }
            this.startedTools.add(key)
            this.activeTools.set(key, { key, summary: 'agent', order: ++this.order })
        } else if (hook === 'SubagentStop') {
            this.finishTool(`agent:${text(value['agent_id'])}`, 'agent')
        } else if (hook === 'PreCompact') {
            const key = 'compact'
            this.startedTools.add(key)
            this.activeTools.set(key, { key, summary: 'compacting', order: ++this.order })
        } else if (hook === 'PostCompact') {
            this.finishTool('compact', 'compacting')
        } else if (hook === 'PostToolBatch') {
            this.closeActiveTools()
        }

        let event = translateClaudeHook(this.sessionId, value, ts)
        if (!event) {
            return null
        }

        if (
            hook === 'PostToolUse' ||
            hook === 'PostToolUseFailure' ||
            hook === 'PermissionDenied' ||
            hook === 'PostCompact' ||
            hook === 'SubagentStop' ||
            event.kind === 'request-resolved'
        ) {
            event = {
                ...event,
                projectedActivity: this.currentActivity() ?? { kind: 'thinking', summary: 'thinking' },
            }
        }

        if (hook === 'PostToolUseFailure' && value['is_interrupt'] === true && !this.hasActiveTools) {
            event = {
                ...event,
                kind: 'turn-completed',
                summary: 'interrupted',
                projectedState: 'idle',
                projectedActivity: { kind: 'turn-completed', summary: 'interrupted' },
            }
        }

        if (hook === 'PostToolBatch') {
            event = {
                ...event,
                projectedActivity: { kind: 'thinking', summary: 'thinking' },
            }
        }

        if (hook === 'Stop') {
            this.closeActiveTools()
            const background = Array.isArray(value['background_tasks'])
                ? value['background_tasks'].filter(item => record(item)['status'] !== 'completed')
                : []
            if (background.length) {
                const type = text(record(background[0])['type']).toLowerCase()
                const summary = type === 'shell' ? 'command: background' :
                    type === 'subagent' || type === 'teammate' ? 'agent' :
                        'background'
                event = {
                    ...event,
                    kind: 'tool-call',
                    summary,
                    projectedState: 'working',
                    projectedActivity: { kind: 'tool-call', summary },
                }
            }
        }

        if (hook === 'StopFailure' || hook === 'SessionEnd') {
            this.closeActiveTools()
        }
        return event
    }

    private finishTool (toolId: string, summary: string): void {
        let key = toolId
        if (!key) {
            key = this.latestActive(summary)?.key ?? ''
        }
        if (key) {
            this.activeTools.delete(key)
            this.finishedTools.add(key)
        }
    }

    private currentActivity (): AiEvent['projectedActivity'] | null {
        const current = this.latestActive()
        return current ? { kind: 'tool-call', summary: current.summary } : null
    }

    private latestActive (summary?: string): ActiveTool|null {
        let latest: ActiveTool|null = null
        for (const tool of this.activeTools.values()) {
            if (
                (summary === undefined || tool.summary === summary) &&
                (!latest || tool.order > latest.order)
            ) {
                latest = tool
            }
        }
        return latest
    }

    private closeActiveTools (): void {
        for (const key of this.activeTools.keys()) {
            this.finishedTools.add(key)
        }
        this.activeTools.clear()
    }

    private resetTurn (): void {
        this.activeTools.clear()
        this.startedTools.clear()
        this.finishedTools.clear()
        this.order = 0
        this.anonymous = 0
    }
}
