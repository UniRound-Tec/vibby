/**
 * How a session is described in the UI — one derivation, three consumers
 * (the side rail's tab cards, its per-pane rows, and the dashboard).
 *
 * Pure module, so it stays unit-testable: the translation keys come back as
 * keys and each caller runs them through its own TranslateService. They are
 * wrapped in the extractor marker, because scripts/i18n-extract.mjs only sees
 * literals inside `_()` or `translate.instant()` — spelling them anywhere else
 * would orphan the entries in locale/*.po.
 */
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'

import { AiSessionSnapshot, AiSessionState } from './events'

/**
 * A session's state as shown, which is wider than the event protocol's:
 * `listening` and `untracked` are things we know about the plumbing rather
 * than about the session.
 */
export type AiDisplayState = AiSessionState | 'listening' | 'untracked'

/**
 * Worst first. This is the sort order everywhere a list of sessions appears,
 * and the tiebreak when one tab's panes disagree about what to show.
 *
 * `error` sits directly under `needs-you`: a session that died is a thing the
 * human has to deal with, so it outranks one that is merely busy or idle.
 */
export const DISPLAY_STATE_RANK: Record<AiDisplayState, number> = {
    'needs-you': 0,
    error: 1,
    working: 2,
    idle: 3,
    listening: 4,
    untracked: 5,
}

/** What we know about one pane, as far as this module is concerned */
export interface SessionFacts {
    /** null until the session's first event arrives */
    snapshot: AiSessionSnapshot | null
    /** null when nothing is monitoring this pane */
    sessionId: string | null
    /** the CLI was spotted in an ordinary terminal rather than launched by us */
    runtimeDetected: boolean
}

/** Either a key to translate, or text from the session that must not be */
export type Caption = { key: string } | { text: string }

export function displayStateFor (facts: SessionFacts): AiDisplayState {
    return facts.snapshot?.state ?? (facts.sessionId ? 'listening' : 'untracked')
}

export function stateLabelKey (state: AiDisplayState): string {
    switch (state) {
        case 'needs-you': return _('Needs you')
        case 'error': return _('Error')
        case 'working': return _('Working')
        case 'idle': return _('Idle')
        case 'listening': return _('Listening')
        case 'untracked': return _('Untracked')
    }
}

/**
 * Why a session has nothing to report yet — which is a different statement
 * from "idle", and the one the rail and the dashboard were each spelling out
 * separately.
 */
function silenceReason (facts: SessionFacts): Caption {
    if (facts.runtimeDetected && !facts.sessionId) {
        return { key: _('Detected in terminal · event monitoring unavailable') }
    }
    if (facts.sessionId) {
        return { key: _('Event monitoring enabled · waiting for CLI activity') }
    }
    return { key: _('Launch only · no event monitoring yet') }
}

/**
 * Just what the session last did, for the dashboard — it shows the scraped
 * status line on its own row, so merging the two here would cost it a line.
 */
export function lastEventCaptionFor (facts: SessionFacts): Caption {
    const summary = facts.snapshot?.lastEvent?.summary
    if (summary) {
        return { text: summary }
    }
    return facts.snapshot ? { text: '' } : silenceReason(facts)
}

/**
 * One line for somewhere with room for one — the side rail.
 *
 * The scraped status line wins over the last hook event when both are there:
 * it is lower confidence but strictly fresher, and a caption that has stopped
 * moving reads as a session that has stopped working.
 */
export function captionFor (facts: SessionFacts): Caption {
    const live = facts.snapshot?.liveStatus
    if (live) {
        return { text: live }
    }
    return lastEventCaptionFor(facts)
}

/** Worst of several panes — what a split tab shows on its single card */
export function loudest<T> (items: T[], stateOf: (item: T) => AiDisplayState): T | null {
    let best: T | null = null
    for (const item of items) {
        if (!best || DISPLAY_STATE_RANK[stateOf(item)] < DISPLAY_STATE_RANK[stateOf(best)]) {
            best = item
        }
    }
    return best
}
