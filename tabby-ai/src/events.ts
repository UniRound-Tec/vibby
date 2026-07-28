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
    'responding' |
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
 * Last stop before an adapter event enters retained UI state: drop the raw hook
 * payload, which carries whole tool inputs and file contents and whose shape no
 * UI should depend on, and bound the summary to one line.
 *
 * The summary itself is shown as-is, prompt text included — a timeline of
 * `user` rows says nothing about which session was doing what. Adapters decide
 * what goes in it; this only limits how much.
 */
export function sanitizeEvent (event: AiEvent): AiEvent {
    const safe = { ...event } as AiEvent & { raw?: unknown }
    delete safe.raw
    return { ...safe, summary: clampSummary(event.summary) }
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
        case 'responding': return 'working'
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

/** Consecutive spinner-less polls before a working session is called finished. */
export const SPINNER_MISSES_TO_END_TURN = 4

/** ...and how long the hook channel must also have been silent. */
export const SPINNER_QUIET_MS_TO_END_TURN = 5000

/**
 * Has a scraped session stopped working without saying so?
 *
 * Nothing leaves `working` except an incoming event, and hook delivery is
 * best-effort: each one is a `curl` the CLI fires and forgets, so a timeout or a
 * failed spawn loses it silently. Losing the terminating event strands the
 * session on `working` until the next prompt, frozen spinner caption and all.
 * A spinner that was seen during this turn and then vanished is the only other
 * evidence that the turn is over. Never seeing one is not equivalent: Claude
 * may still be waiting for its first response after prompt submission.
 *
 * This is a net for lost events, not for interrupts: Claude Code does fire Stop
 * when the user presses ESC (verified on 2.1.220), and that path needs no help.
 *
 * All three guards earn their place. The observed flag prevents a slow first
 * response from being called idle. The poll count rides out a repaint that
 * lands between two reads. The quiet window restarts on every event, so a tool
 * call keeps the session alive.
 */
export function spinnerAbsenceEndsTurn (
    consecutiveMisses: number,
    msSinceLastEvent: number,
    observedSpinnerThisTurn: boolean,
): boolean {
    return observedSpinnerThisTurn &&
        consecutiveMisses >= SPINNER_MISSES_TO_END_TURN &&
        msSinceLastEvent >= SPINNER_QUIET_MS_TO_END_TURN
}
