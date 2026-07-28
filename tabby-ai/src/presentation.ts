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
 * The state machine deliberately keeps reasoning inside `working`, but the
 * user-facing activity word should preserve that more precise live signal.
 * Sorting, attention transitions and device output continue to use the coarse
 * state returned by displayStateFor().
 */
export function activityLabelKey (facts: SessionFacts): string {
    if (
        facts.snapshot?.state === 'working' &&
        facts.snapshot.lastEvent?.kind === 'thinking'
    ) {
        return _('Thinking')
    }
    return stateLabelKey(displayStateFor(facts))
}

/**
 * Just what the session last did, for the dashboard — it shows the scraped
 * status line on its own row, so merging the two here would cost it a line.
 * Before the first event, the adjacent state label already says Listening or
 * Untracked; repeating that as a sentence only adds visual noise.
 */
export function lastEventCaptionFor (facts: SessionFacts): Caption {
    const summary = facts.snapshot?.lastEvent?.summary
    if (summary) {
        return { text: summary }
    }
    return { text: '' }
}

/**
 * One line for somewhere with room for one — the side rail.
 *
 * Structured tool activity wins while it is the latest hook event: the rail is
 * the user's at-a-glance view of what the CLI is doing, and a continuously
 * repainted spinner must not hide `web`, `edit: auth.ts`, and similar captions.
 *
 * For every other event, the scraped status line wins. It is lower confidence
 * but fresher, and a caption that has stopped moving reads as a session that
 * has stopped working.
 */
export function captionFor (facts: SessionFacts): Caption {
    const eventKind = facts.snapshot?.lastEvent?.kind
    if (eventKind === 'tool-call' || eventKind === 'tool-result') {
        return lastEventCaptionFor(facts)
    }
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
