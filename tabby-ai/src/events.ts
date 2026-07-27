/**
 * vibby AI event protocol v0 (docs/06-m2-plan.md §1).
 *
 * Consumed by the dashboard (M2), hardware channel (M3) and any future
 * external protocol — keep this module pure: types + functions only,
 * no framework imports.
 */

export type AiSessionState = 'working' | 'needs-you' | 'idle' | 'error'

export type AiEventConfidence = 'high' | 'low'

export type AiEventKind =
    'session-started' |
    'prompt-submitted' |
    'thinking' |
    'tool-call' |
    'tool-result' |
    'permission-request' |
    'question-request' |
    'request-resolved' |
    'retrying' |
    'turn-completed' |
    'notification' |
    'session-error' |
    'session-ended' |
    'process-exited'

/** Small-screen budget for AiEvent.summary (D5) */
export const SUMMARY_MAX_LENGTH = 48

export interface AiEvent {
    /** vibby-side session id, generated at spawn time — not the CLI's own session id */
    sessionId: string

    ts: number

    kind: AiEventKind

    /** hook source = high; control sequences / output heuristics = low */
    confidence: AiEventConfidence

    /** Small-screen-ready short text, e.g. `edit: auth.ts` — clamped by the bus */
    summary: string

    /** Original adapter payload; UI must not depend on its shape */
    raw?: unknown

    /**
     * Adapter-projected aggregate state. OpenCode uses this when several
     * native root/child sessions share one Vibby pane. Claude leaves it unset.
     */
    projectedState?: AiSessionState
}

export interface AiSessionSnapshot {
    sessionId: string

    state: AiSessionState

    /** When the current state was entered (dashboard duration column) */
    since: number

    lastEvent: AiEvent | null

    /**
     * Low-confidence live caption scraped from the CLI's own status line
     * (e.g. claude's `Flambéing… (17s · ↓ 1.2k tokens)`). Survives events that
     * keep the session working — the spinner keeps running across tool calls —
     * and is dropped the moment the state leaves `working`.
     */
    liveStatus?: string | null
}

export function clampSummary (text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    if (flat.length <= SUMMARY_MAX_LENGTH) {
        return flat
    }
    return flat.slice(0, SUMMARY_MAX_LENGTH - 1) + '…'
}

/**
 * State implied by an event, or null when the event freezes the current
 * state (session-ended keeps whatever the session ended in).
 */
export function stateAfter (kind: AiEventKind): AiSessionState | null {
    switch (kind) {
        case 'session-started': return 'idle'
        case 'prompt-submitted': return 'working'
        case 'thinking': return 'working'
        case 'tool-call': return 'working'
        case 'tool-result': return 'working'
        case 'permission-request': return 'needs-you'
        case 'question-request': return 'needs-you'
        case 'request-resolved': return null
        case 'retrying': return 'working'
        case 'notification': return 'needs-you'
        case 'turn-completed': return 'idle'
        case 'session-error': return 'error'
        case 'session-ended': return null
        case 'process-exited': return 'error'
    }
}

export function reduceSnapshot (prev: AiSessionSnapshot | null, event: AiEvent): AiSessionSnapshot {
    const prevState = prev?.state ?? null
    const nextState = event.projectedState ?? stateAfter(event.kind) ?? prevState ?? 'idle'
    return {
        sessionId: event.sessionId,
        state: nextState,
        since: prevState === nextState && prev ? prev.since : event.ts,
        lastEvent: event,
        liveStatus: nextState === 'working' ? prev?.liveStatus ?? null : null,
    }
}

/**
 * The attention pulse (D5): fires on any transition out of `working` —
 * the moment the human becomes the bottleneck. M2 consumer: desktop
 * notifications; M3 consumer: hardware blink.
 */
export function isAttentionTransition (prev: AiSessionState | null, next: AiSessionState): boolean {
    return prev === 'working' && next !== 'working'
}
