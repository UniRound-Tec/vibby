export const FLOATING_SESSION_COLLAPSED_LIMIT = 3
export const FLOATING_SESSION_NAME_MAX_LENGTH = 120
export const FLOATING_SESSION_SUMMARY_MAX_LENGTH = 160
export const FLOATING_SESSION_SOURCE_LIMIT = 500
export const AI_FLOATING_CHANNELS = {
    replaceSource: 'ai-floating:replace-source',
    removeSource: 'ai-floating:remove-source',
    snapshot: 'ai-floating:snapshot',
    ready: 'ai-floating:ready',
    focusSession: 'ai-floating:focus-session',
    setExpanded: 'ai-floating:set-expanded',
    moveWindow: 'ai-floating:move-window',
} as const

export type FloatingSessionDisplayState =
    | 'working'
    | 'needs-you'
    | 'idle'
    | 'error'
    | 'listening'
    | 'untracked'

export interface FloatingSessionSnapshot {
    sessionId: string
    sourceWindowId: number
    kind: string
    name: string
    state: FloatingSessionDisplayState
    stateLabel: string
    summary: string | null
    createdAt: number
    lastActivityAt: number
}

export type FloatingWindowColorScheme = 'dark' | 'light'

export interface FloatingSessionSourceSnapshot {
    sourceWindowId: number
    enabled: boolean
    colorScheme: FloatingWindowColorScheme
    sessions: FloatingSessionSnapshot[]
}

export interface FloatingSessionWindowSnapshot {
    colorScheme: FloatingWindowColorScheme
    sessions: FloatingSessionSnapshot[]
}

export interface FloatingSessionSourceBridge {
    replaceSource: (snapshot: FloatingSessionSourceSnapshot) => void
    removeSource: (sourceWindowId: number) => void
    onFocus: (callback: (value: unknown) => void) => void
}

declare global {
    interface Window {
        vibbyFloatingSessionSource?: FloatingSessionSourceBridge
    }
}

const DISPLAY_STATES: readonly FloatingSessionDisplayState[] = [
    'working',
    'needs-you',
    'idle',
    'error',
    'listening',
    'untracked',
]

function isRecord (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString (value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') {
        return null
    }
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized ? normalized.slice(0, maxLength) : null
}

function timestamp (value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : null
}

function normalizeSession (
    value: unknown,
    sourceWindowId: number,
): FloatingSessionSnapshot | null {
    if (!isRecord(value)) {
        return null
    }

    const sessionId = boundedString(value.sessionId, 128)
    const kind = boundedString(value.kind, 64)
    const name = boundedString(value.name, FLOATING_SESSION_NAME_MAX_LENGTH)
    const stateLabel = boundedString(value.stateLabel, 48)
    const createdAt = timestamp(value.createdAt)
    const lastActivityAt = timestamp(value.lastActivityAt)
    const state = value.state
    const summary = value.summary === null
        ? null
        : boundedString(value.summary, FLOATING_SESSION_SUMMARY_MAX_LENGTH)

    if (
        !sessionId ||
        !kind ||
        !name ||
        !stateLabel ||
        createdAt === null ||
        lastActivityAt === null ||
        typeof state !== 'string' ||
        !DISPLAY_STATES.includes(state as FloatingSessionDisplayState) ||
        value.summary !== null && summary === null
    ) {
        return null
    }

    return {
        sessionId,
        sourceWindowId,
        kind,
        name,
        state: state as FloatingSessionDisplayState,
        stateLabel,
        summary,
        createdAt,
        lastActivityAt,
    }
}

export function normalizeFloatingSessionSource (
    value: unknown,
): FloatingSessionSourceSnapshot | null {
    if (!isRecord(value)) {
        return null
    }
    const sourceWindowId = value.sourceWindowId
    if (
        !Number.isInteger(sourceWindowId) ||
        sourceWindowId as number <= 0 ||
        typeof value.enabled !== 'boolean' ||
        value.colorScheme !== 'dark' && value.colorScheme !== 'light' ||
        !Array.isArray(value.sessions) ||
        value.sessions.length > FLOATING_SESSION_SOURCE_LIMIT
    ) {
        return null
    }

    const sessions: FloatingSessionSnapshot[] = []
    for (const session of value.sessions) {
        const normalized = normalizeSession(session, sourceWindowId as number)
        if (!normalized) {
            return null
        }
        sessions.push(normalized)
    }

    return {
        sourceWindowId: sourceWindowId as number,
        enabled: value.enabled,
        colorScheme: value.colorScheme,
        sessions,
    }
}

function compareSessions (
    a: FloatingSessionSnapshot,
    b: FloatingSessionSnapshot,
): number {
    return b.lastActivityAt - a.lastActivityAt ||
        b.createdAt - a.createdAt ||
        a.sessionId.localeCompare(b.sessionId)
}

export function mergeFloatingSessionSources (
    sources: readonly FloatingSessionSourceSnapshot[],
): FloatingSessionSnapshot[] {
    const counts = new Map<string, number>()
    for (const source of sources) {
        for (const session of source.sessions) {
            counts.set(session.sessionId, (counts.get(session.sessionId) ?? 0) + 1)
        }
    }

    const unique: FloatingSessionSnapshot[] = []
    for (const source of sources) {
        for (const session of source.sessions) {
            if (counts.get(session.sessionId) === 1) {
                unique.push(session)
            }
        }
    }
    return unique.sort(compareSessions)
}

export function sortFloatingSessions (
    sessions: readonly FloatingSessionSnapshot[],
): FloatingSessionSnapshot[] {
    return [...sessions].sort(compareSessions)
}

export function visibleFloatingSessions (
    sessions: readonly FloatingSessionSnapshot[],
    expanded: boolean,
): FloatingSessionSnapshot[] {
    const sorted = sortFloatingSessions(sessions)
    return expanded ? sorted : sorted.slice(0, FLOATING_SESSION_COLLAPSED_LIMIT)
}
