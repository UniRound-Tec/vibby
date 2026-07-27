// Attention notifications: the renderer picks a reason, the main process turns
// it into an OS toast. Both sides of that seam are pure, so the macOS and Linux
// branches are covered here even when the suite runs on Windows.
const assert = require('node:assert/strict')
const {
    NOTIFICATION_BODY_MAX_LENGTH,
    NOTIFICATION_TITLE_MAX_LENGTH,
    activatedSessionId,
    normalizeAiNotificationRequest,
    notificationPresentation,
} = require('../.test-build/notifications.js')

// --- presentation: a blocked session is loud and sticky, a finished one is not ---
const win = reason => notificationPresentation(reason, 'win32')
const mac = reason => notificationPresentation(reason, 'darwin')
const linux = reason => notificationPresentation(reason, 'linux')

for (const blocking of ['needs-you', 'error']) {
    assert.equal(win(blocking).silent, false, blocking)
    // the one toast the user must not miss has to outlive a glance away
    assert.equal(win(blocking).timeoutType, 'never', blocking)
    assert.equal(linux(blocking).urgency, 'critical', blocking)
    assert.equal(mac(blocking).bounceDock, true, blocking)
}

// A turn ending is an FYI: it arrives on every single answer, so it must not
// make noise, jump the dock, or stay on screen.
assert.equal(win('idle').silent, true)
assert.equal(win('idle').timeoutType, 'default')
assert.equal(linux('idle').urgency, 'low')
assert.equal(mac('idle').bounceDock, false)
assert.equal(linux('idle').bounceDock, false)
assert.equal(win('needs-you').bounceDock, false, 'no dock outside macOS')

// Each platform key is only set where the OS reads it, so a reviewer can see
// which branch owns what instead of guessing which fields are inert.
assert.equal(win('needs-you').urgency, undefined, 'urgency is Linux-only')
assert.equal(linux('needs-you').timeoutType, undefined, 'timeoutType is Windows-only')
assert.equal(mac('needs-you').urgency, undefined)
assert.equal(mac('needs-you').timeoutType, undefined)

// --- request validation: this crosses the renderer/main boundary ---
const valid = {
    sessionId: 'session-1',
    reason: 'needs-you',
    title: 'codex — src',
    body: 'command: git status',
}
assert.deepEqual(normalizeAiNotificationRequest(valid), valid)

// a summary can legitimately be absent; the title still names the session
assert.equal(normalizeAiNotificationRequest({ ...valid, body: undefined }).body, '')
assert.equal(normalizeAiNotificationRequest({ ...valid, body: '   ' }).body, '')

// anything that is not a well-formed request is dropped rather than shown
assert.equal(normalizeAiNotificationRequest(null), null)
assert.equal(normalizeAiNotificationRequest('needs-you'), null)
assert.equal(normalizeAiNotificationRequest([valid]), null)
assert.equal(normalizeAiNotificationRequest({ ...valid, sessionId: '' }), null)
assert.equal(normalizeAiNotificationRequest({ ...valid, sessionId: 42 }), null)
assert.equal(normalizeAiNotificationRequest({ ...valid, title: '' }), null)
assert.equal(normalizeAiNotificationRequest({ ...valid, reason: 'working' }), null,
    'only the three post-working outcomes are notifiable')
assert.equal(normalizeAiNotificationRequest({ ...valid, reason: undefined }), null)

// a toast is one line, so control characters and runaway CLI output are tamed
assert.equal(
    normalizeAiNotificationRequest({ ...valid, body: 'first\nsecond\t third' }).body,
    'first second third',
)
const long = normalizeAiNotificationRequest({
    ...valid,
    title: 'T'.repeat(500),
    body: 'B'.repeat(1000),
})
assert.equal(long.title.length, NOTIFICATION_TITLE_MAX_LENGTH)
assert.equal(long.body.length, NOTIFICATION_BODY_MAX_LENGTH)

// --- click payload: comes back over IPC, so it is untrusted too ---
assert.equal(activatedSessionId({ sessionId: 'session-1' }), 'session-1')
assert.equal(activatedSessionId({ sessionId: '' }), null)
assert.equal(activatedSessionId({ sessionId: 'x'.repeat(200) }), null)
assert.equal(activatedSessionId({}), null)
assert.equal(activatedSessionId(null), null)
assert.equal(activatedSessionId('session-1'), null)

console.log('notifications.test.cjs: all assertions passed')
