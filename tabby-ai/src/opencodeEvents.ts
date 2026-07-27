import * as path from 'path'

import { AiEvent, AiEventKind, AiSessionState, SUMMARY_MAX_LENGTH } from './events'

// The decoder needs a string-keyed JSON object; this is the exact utility
// shape Record expresses and avoids a misleading domain interface.
// eslint-disable-next-line @typescript-eslint/no-type-alias
type JsonObject = Record<string, unknown>
type NativeStatus = 'busy'|'retry'|'idle'|'error'

interface NativeSessionState {
    parentId: string|null
    status: NativeStatus
    permissions: Set<string>
    questions: Set<string>
}

interface NativePartState {
    type: string
    text: string
}

interface NativeProjection {
    kind: AiEventKind
    summary: string
}

function object (value: unknown): JsonObject|null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : null
}

function text (value: unknown): string|null {
    return typeof value === 'string' && value ? value : null
}

function numberValue (value: unknown): number|null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sessionIdOf (properties: JsonObject): string|null {
    const info = object(properties['info'])
    const part = object(properties['part'])
    return text(properties['sessionID']) ??
        text(properties['sessionId']) ??
        text(info?.['id']) ??
        text(info?.['sessionID']) ??
        text(part?.['sessionID']) ??
        null
}

function requestIdOf (properties: JsonObject): string {
    const request = object(properties['request'])
    return text(properties['id']) ??
        text(properties['requestID']) ??
        text(properties['permissionID']) ??
        text(request?.['id']) ??
        'pending'
}

function baseName (value: unknown): string|null {
    const raw = text(value)
    // win32 flavour explicitly: it accepts both separators, while on Linux
    // the platform default reads a Windows path as one long file name — and
    // a WSL-side OpenCode session reports exactly such paths.
    return raw ? path.win32.basename(raw) : null
}

function firstText (...values: unknown[]): string|null {
    for (const value of values) {
        const result = text(value)
        if (result) {
            return result
        }
    }
    return null
}

function toolSummary (part: JsonObject, result: boolean): string {
    const tool = (text(part['tool']) ?? 'tool').toLowerCase()
    const state = object(part['state']) ?? {}
    const input = object(state['input']) ?? {}
    const title = text(state['title'])
    const file = baseName(input['filePath']) ?? baseName(input['path']) ?? baseName(input['file'])

    let detail: string|null = null
    if (['read', 'write', 'edit'].includes(tool)) {
        detail = file
    } else if (tool === 'bash' || tool === 'shell') {
        detail = firstText(input['command'], input['cmd'])
    } else if (tool === 'grep' || tool === 'glob') {
        detail = firstText(input['pattern'], input['query'])
    } else if (tool === 'task' || tool === 'subtask') {
        detail = firstText(input['description'], input['prompt'])
    }
    detail ??= title

    const status = text(state['status'])
    if (result && status === 'error') {
        return `${tool}: failed`
    }
    if (result && !detail) {
        return `${tool}: done`
    }
    return detail ? `${tool}: ${detail}` : tool
}

function permissionSummary (properties: JsonObject): string {
    const request = object(properties['request']) ?? properties
    const title = firstText(request['title'], request['permission'], request['type'])
    return title ? `permission: ${title}` : 'permission required'
}

function questionSummary (properties: JsonObject): string {
    const request = object(properties['request']) ?? properties
    const questions = Array.isArray(request['questions']) ? request['questions'] as unknown[] : []
    const first = object(questions[0])
    const title = firstText(first?.['header'], first?.['question'], request['question'], request['title'])
    return title ? `question: ${title}` : 'question: input needed'
}

function errorSummary (properties: JsonObject): string {
    const error = object(properties['error'])
    const data = object(error?.['data'])
    const message = firstText(data?.['message'], error?.['message'], properties['message'])
    return message ? `error: ${message}` : 'session error'
}

/** The part text is cumulative; show its newest content, not its stale prefix. */
function reasoningSummary (part: JsonObject, properties: JsonObject): string|null {
    const raw = firstText(part['text'], properties['delta'])
    if (!raw) {
        return null
    }
    const flat = raw.replace(/\s+/g, ' ').trim()
    if (!flat) {
        return null
    }
    return flat.length <= SUMMARY_MAX_LENGTH
        ? flat
        : `…${flat.slice(-(SUMMARY_MAX_LENGTH - 1))}`
}

/**
 * Stateful but framework-free OpenCode event projector.
 *
 * A dedicated OpenCode server can report multiple root/child sessions. They
 * remain private here and collapse into one pane-level projectedState.
 */
export class OpenCodeEventProjector {
    private sessions = new Map<string, NativeSessionState>()
    private parts = new Map<string, NativePartState>()
    private seenUserMessages = new Set<string>()

    constructor (private vibbySessionId: string) { }

    apply (payload: unknown, ts: number): AiEvent|null {
        const envelope = object(payload)
        const type = text(envelope?.['type'])
        const properties = object(envelope?.['properties'])
        if (!type || !properties) {
            return null
        }

        const sessionId = sessionIdOf(properties)
        const session = sessionId ? this.ensureSession(sessionId, properties) : null
        let kind: AiEventKind|null = null
        let summary = ''

        switch (type) {
            case 'server.connected':
                kind = 'session-started'
                summary = 'OpenCode connected'
                break
            case 'session.created':
                kind = 'session-started'
                summary = 'session started'
                break
            case 'session.updated':
                return null
            case 'session.status': {
                if (!session) {
                    return null
                }
                const status = object(properties['status'])
                const statusType = text(status?.['type'])
                if (statusType === 'busy') {
                    session.status = 'busy'
                    kind = 'prompt-submitted'
                    summary = 'working'
                } else if (statusType === 'retry') {
                    session.status = 'retry'
                    kind = 'retrying'
                    const attempt = numberValue(status?.['attempt'])
                    const message = text(status?.['message'])
                    summary = [
                        'retry',
                        attempt === null ? null : `#${attempt}`,
                        message,
                    ].filter(Boolean).join(' ')
                } else if (statusType === 'idle') {
                    session.status = 'idle'
                    kind = 'turn-completed'
                    summary = 'turn complete'
                } else {
                    return null
                }
                break
            }
            case 'session.idle':
                if (!session) {
                    return null
                }
                session.status = 'idle'
                kind = 'turn-completed'
                summary = 'turn complete'
                break
            case 'message.updated': {
                if (!session) {
                    return null
                }
                const info = object(properties['info'])
                if (info?.['role'] === 'user') {
                    const messageId = text(info['id'])
                    if (messageId && this.seenUserMessages.has(messageId)) {
                        // v1.17.9 replays the same user message after tool
                        // boundaries and even after session.idle.
                        return null
                    }
                    if (messageId) {
                        this.seenUserMessages.add(messageId)
                    }
                    session.status = 'busy'
                    kind = 'prompt-submitted'
                    summary = 'prompt submitted'
                } else if (object(info?.['error'])) {
                    session.status = 'error'
                    kind = 'session-error'
                    summary = errorSummary({ error: info?.['error'] })
                } else {
                    return null
                }
                break
            }
            case 'message.part.updated': {
                if (!session) {
                    return null
                }
                const projected = this.projectPartUpdated(session, properties)
                if (!projected) {
                    return null
                }
                kind = projected.kind
                summary = projected.summary
                break
            }
            case 'message.part.delta': {
                const projected = session ? this.projectPartDelta(session, properties) : null
                if (!projected) {
                    return null
                }
                kind = projected.kind
                summary = projected.summary
                break
            }
            case 'session.next.reasoning.started':
                if (!session) {
                    return null
                }
                session.status = 'busy'
                kind = 'thinking'
                summary = 'thinking'
                break
            case 'session.next.reasoning.delta': {
                const projected = session ? this.projectNextReasoningDelta(session, properties) : null
                if (!projected) {
                    return null
                }
                kind = projected.kind
                summary = projected.summary
                break
            }
            case 'message.part.removed': {
                const partId = text(properties['partID'])
                if (partId) {
                    this.parts.delete(partId)
                }
                return null
            }
            case 'permission.updated':
            case 'permission.asked':
                if (!session) {
                    return null
                }
                session.permissions.add(requestIdOf(properties))
                kind = 'permission-request'
                summary = permissionSummary(properties)
                break
            case 'permission.replied':
                if (!session) {
                    return null
                }
                session.permissions.delete(requestIdOf(properties))
                kind = 'request-resolved'
                summary = 'permission resolved'
                break
            case 'question.asked':
                if (!session) {
                    return null
                }
                session.questions.add(requestIdOf(properties))
                kind = 'question-request'
                summary = questionSummary(properties)
                break
            case 'question.replied':
            case 'question.rejected':
                if (!session) {
                    return null
                }
                session.questions.delete(requestIdOf(properties))
                kind = 'request-resolved'
                summary = 'question resolved'
                break
            case 'session.error':
                if (session) {
                    session.status = 'error'
                }
                kind = 'session-error'
                summary = errorSummary(properties)
                break
            case 'session.deleted':
                if (sessionId) {
                    this.sessions.delete(sessionId)
                }
                kind = 'session-ended'
                summary = 'session ended'
                break
            default:
                return null
        }

        return {
            sessionId: this.vibbySessionId,
            ts,
            kind,
            confidence: 'high',
            summary,
            projectedState: this.aggregateState(),
        }
    }

    reconcileStatuses (statuses: unknown, ts: number): AiEvent|null {
        const values = object(statuses)
        if (!values) {
            return null
        }
        for (const [sessionId, rawStatus] of Object.entries(values)) {
            const status = object(rawStatus)
            const type = text(status?.['type'])
            if (type === 'busy' || type === 'retry' || type === 'idle') {
                this.ensureSession(sessionId).status = type
            }
        }
        return {
            sessionId: this.vibbySessionId,
            ts,
            kind: this.aggregateState() === 'idle' ? 'turn-completed' : 'notification',
            confidence: 'high',
            summary: 'state reconciled',
            projectedState: this.aggregateState(),
        }
    }

    private projectPartUpdated (
        session: NativeSessionState,
        properties: JsonObject,
    ): NativeProjection|null {
        const part = object(properties['part'])
        if (!part) {
            return null
        }
        const partId = text(part['id'])
        const partType = text(part['type'])
        // captured before the set below, so a re-sent part can be told apart
        // from a new one
        const alreadyKnown = partId ? this.parts.has(partId) : false
        if (partId && partType) {
            this.parts.set(partId, {
                type: partType,
                text: typeof part['text'] === 'string' ? part['text'] : '',
            })
        }
        if (partType === 'text') {
            // The prompt arrives here rather than on message.updated, whose info
            // block is metadata only (verified against 1.18.7). Its messageID is
            // already in seenUserMessages because the user's message.updated
            // lands first — which is also what tells it apart from the
            // assistant's reply, whose text must not stream into the timeline.
            const messageId = text(part['messageID'])
            if (alreadyKnown || !messageId || !this.seenUserMessages.has(messageId)) {
                return null
            }
            session.status = 'busy'
            return { kind: 'prompt-submitted', summary: `user: ${text(part['text'])}` }
        }
        if (partType === 'tool') {
            const state = object(part['state'])
            const status = text(state?.['status'])
            const result = status === 'completed' || status === 'error'
            session.status = 'busy'
            return {
                kind: result ? 'tool-result' : 'tool-call',
                summary: toolSummary(part, result),
            }
        }
        if (partType === 'reasoning') {
            const reasoning = reasoningSummary(part, properties)
            if (!reasoning) {
                return null
            }
            session.status = 'busy'
            return { kind: 'thinking', summary: reasoning }
        }
        if (partType === 'subtask' || partType === 'agent') {
            session.status = 'busy'
            return {
                kind: 'tool-call',
                summary: firstText(part['description'], part['name']) ?? partType,
            }
        }
        return null
    }

    private projectPartDelta (
        session: NativeSessionState,
        properties: JsonObject,
    ): NativeProjection|null {
        if (properties['field'] !== 'text') {
            return null
        }
        const partId = text(properties['partID'])
        const delta = text(properties['delta'])
        const part = partId ? this.parts.get(partId) : null
        if (!part || part.type !== 'reasoning' || !delta) {
            return null
        }
        part.text += delta
        session.status = 'busy'
        return {
            kind: 'thinking',
            summary: reasoningSummary({ text: part.text }, properties) ?? 'thinking',
        }
    }

    private projectNextReasoningDelta (
        session: NativeSessionState,
        properties: JsonObject,
    ): NativeProjection|null {
        const delta = text(properties['delta'])
        if (!delta) {
            return null
        }
        const reasoningId = text(properties['reasoningID'])
        const part = reasoningId
            ? this.parts.get(reasoningId) ?? { type: 'reasoning', text: '' }
            : { type: 'reasoning', text: '' }
        part.text += delta
        if (reasoningId) {
            this.parts.set(reasoningId, part)
        }
        session.status = 'busy'
        return {
            kind: 'thinking',
            summary: reasoningSummary({ text: part.text }, properties) ?? 'thinking',
        }
    }

    private ensureSession (sessionId: string, properties?: JsonObject): NativeSessionState {
        let session = this.sessions.get(sessionId)
        if (!session) {
            session = {
                parentId: null,
                status: 'idle',
                permissions: new Set(),
                questions: new Set(),
            }
            this.sessions.set(sessionId, session)
        }
        const info = object(properties?.['info'])
        const parentId = text(info?.['parentID']) ?? text(properties?.['parentID'])
        if (parentId) {
            session.parentId = parentId
        }
        return session
    }

    private aggregateState (): AiSessionState {
        const sessions = [...this.sessions.values()]
        if (sessions.some(x => x.permissions.size > 0 || x.questions.size > 0)) {
            return 'needs-you'
        }
        if (sessions.some(x => x.status === 'error')) {
            return 'error'
        }
        if (sessions.some(x => x.status === 'busy' || x.status === 'retry')) {
            return 'working'
        }
        return 'idle'
    }
}
