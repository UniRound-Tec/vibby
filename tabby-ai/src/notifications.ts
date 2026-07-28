/**
 * Attention notifications, shared between the renderer that decides to notify
 * and the main process that owns the OS toast.
 *
 * The renderer sends what happened; everything about how it is presented lives
 * in `notificationPresentation` so the three platform branches are pure and
 * testable from any one of them.
 */

export const AI_NOTIFICATION_CHANNELS = {
    /** renderer → main: please show this */
    notify: 'ai-notification:notify',
    /** main → renderer: the user clicked one */
    activated: 'ai-notification:activated',
} as const

export const NOTIFICATION_TITLE_MAX_LENGTH = 120
export const NOTIFICATION_BODY_MAX_LENGTH = 240
export const NOTIFICATION_SESSION_ID_MAX_LENGTH = 128

/**
 * Why we are interrupting. The three cases the attention pulse can produce
 * once `working` ends — see stateAfter() in events.ts.
 */
export type AiNotificationReason = 'needs-you' | 'error' | 'idle'

export type AiNotificationCliKind = 'claude-code' | 'codex' | 'opencode'

export const AI_NOTIFICATION_CLI_KINDS: readonly AiNotificationCliKind[] = [
    'claude-code',
    'codex',
    'opencode',
]

export interface AiNotificationRequest {
    sessionId: string
    reason: AiNotificationReason
    cliKind: AiNotificationCliKind | null
    title: string
    body: string
}

export interface AiNotificationDecisionInput {
    notificationsEnabled: boolean
    notifyOnIdle: boolean
    reason: AiNotificationReason
    viewingSession: boolean
    throttled: boolean
}

/**
 * Renderer-side delivery policy. Kept pure so foreground/background behavior
 * cannot silently drift while the platform-specific toast code stays unchanged.
 */
export function shouldDeliverAiNotification (
    input: AiNotificationDecisionInput,
): boolean {
    if (!input.notificationsEnabled || input.throttled) {
        return false
    }
    if (input.reason === 'idle' && !input.notifyOnIdle) {
        return false
    }
    // Foreground visibility is intentionally not a veto. A completion or
    // attention transition is useful even while the terminal is visible:
    // the OS toast is the consistent acknowledgement that the turn changed.
    return true
}

/** `process.platform`, narrowed to what we ship. */
export type AiNotificationPlatform = 'win32' | 'darwin' | 'linux'

export interface AiNotificationPresentation {
    /** Every attention transition is audible. */
    silent: boolean
    /** Linux only. 'critical' survives until dismissed instead of fading. */
    urgency?: 'low' | 'normal' | 'critical'
    /** Windows only. 'never' parks the toast in Notification Center. */
    timeoutType?: 'default' | 'never'
    /** macOS only, and only when the user is actually needed. */
    bounceDock: boolean
}

/**
 * Installed on the main window by app/src/aiNotificationBridge.ts, mirroring
 * `vibbyFloatingSessionSource`. Absent wherever there is no main process, so
 * every call site must go through `?.` rather than assume Electron.
 */
export interface AiNotificationBridge {
    notify: (request: AiNotificationRequest) => void
    /** Fires when the user clicks a toast; the payload is untrusted. */
    onActivated: (callback: (value: unknown) => void) => void
}

declare global {
    interface Window {
        vibbyAiNotifications?: AiNotificationBridge
    }
}

const REASONS: readonly AiNotificationReason[] = ['needs-you', 'error', 'idle']

export function normalizeAiNotificationCliKind (value: unknown): AiNotificationCliKind | null {
    return typeof value === 'string' &&
        AI_NOTIFICATION_CLI_KINDS.includes(value as AiNotificationCliKind)
        ? value as AiNotificationCliKind
        : null
}

/**
 * A session that stopped working either wants something (`needs-you`), broke
 * (`error`), or simply finished its turn (`idle`). Every case is audible and
 * persistent; only blocking cases bounce the macOS dock.
 */
export function notificationPresentation (
    reason: AiNotificationReason,
    platform: AiNotificationPlatform,
): AiNotificationPresentation {
    const blocking = reason !== 'idle'
    const presentation: AiNotificationPresentation = {
        silent: false,
        bounceDock: platform === 'darwin' && blocking,
    }
    if (platform === 'linux') {
        presentation.urgency = 'critical'
    }
    if (platform === 'win32') {
        presentation.timeoutType = 'never'
    }
    return presentation
}

function isRecord (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString (value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') {
        return null
    }
    // Collapsed because a toast is a single line either way, and a body full of
    // newlines from a CLI summary just truncates the useful part off screen.
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized ? normalized.slice(0, maxLength) : null
}

/**
 * Renderer input reaching the main process is untrusted, exactly as in
 * normalizeFloatingSessionSource().
 */
export function normalizeAiNotificationRequest (
    value: unknown,
): AiNotificationRequest | null {
    if (!isRecord(value)) {
        return null
    }
    const sessionId = boundedString(value.sessionId, NOTIFICATION_SESSION_ID_MAX_LENGTH)
    const title = boundedString(value.title, NOTIFICATION_TITLE_MAX_LENGTH)
    const body = boundedString(value.body, NOTIFICATION_BODY_MAX_LENGTH)
    const reason = value.reason
    if (
        !sessionId ||
        !title ||
        typeof reason !== 'string' ||
        !REASONS.includes(reason as AiNotificationReason)
    ) {
        return null
    }
    return {
        sessionId,
        reason: reason as AiNotificationReason,
        cliKind: normalizeAiNotificationCliKind(value.cliKind),
        title,
        // an empty summary is normal — the title alone still says who wants you
        body: body ?? '',
    }
}

/** The session id carried back by a toast click, or null if the payload is junk. */
export function activatedSessionId (value: unknown): string | null {
    if (!isRecord(value)) {
        return null
    }
    const sessionId = value.sessionId
    return typeof sessionId === 'string' &&
        sessionId.length > 0 &&
        sessionId.length <= NOTIFICATION_SESSION_ID_MAX_LENGTH
        ? sessionId
        : null
}
