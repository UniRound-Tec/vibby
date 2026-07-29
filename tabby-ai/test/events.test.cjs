// Unit tests for the pure event protocol module (docs/06-m2-plan.md §5 WP0).
// Run via `yarn test` in tabby-ai/ — compiles src/events.ts alone with the
// repo's tsc, then asserts against the CJS output. No test framework.
const assert = require('node:assert/strict')
const {
    SUMMARY_MAX_LENGTH,
    SPINNER_MISSES_TO_END_TURN,
    SPINNER_QUIET_MS_TO_END_TURN,
    clampSummary,
    sanitizeEvent,
    stateAfter,
    reduceSnapshot,
    isAttentionTransition,
    spinnerAbsenceEndsTurn,
} = require('../.test-build/events.js')

// The raw hook payload is dropped — it carries whole tool inputs and file
// contents — while the summary the adapter composed is kept as-is.
assert.deepEqual(sanitizeEvent({
    sessionId: 's',
    ts: 1,
    kind: 'prompt-submitted',
    confidence: 'high',
    summary: 'user: fix the flaky test',
    raw: { prompt: 'fix the flaky test', cwd: '/home/me/secret-project' },
}), {
    sessionId: 's',
    ts: 1,
    kind: 'prompt-submitted',
    confidence: 'high',
    summary: 'user: fix the flaky test',
})

// ...and it is still bounded to one line, so a pasted wall of text cannot
// stretch a dashboard row or a floating-window caption.
const pasted = sanitizeEvent({
    sessionId: 's',
    ts: 1,
    kind: 'prompt-submitted',
    confidence: 'high',
    summary: 'user: ' + 'x'.repeat(500),
})
assert.equal(pasted.summary.length, SUMMARY_MAX_LENGTH)
assert.equal(
    sanitizeEvent({
        sessionId: 's', ts: 1, kind: 'prompt-submitted', confidence: 'high',
        summary: 'user: first line\nsecond line',
    }).summary,
    'user: first line second line',
    'newlines collapse rather than breaking the row',
)

const ev = (kind, overrides = {}) => ({
    sessionId: 's1',
    ts: 1000,
    kind,
    confidence: 'high',
    summary: 'x',
    ...overrides,
})

// --- transition table (plan §1) ---
assert.equal(stateAfter('session-started'), 'idle')
assert.equal(stateAfter('prompt-submitted'), 'working')
assert.equal(stateAfter('tool-call'), 'working')
assert.equal(stateAfter('thinking'), 'working')
assert.equal(stateAfter('responding'), 'working')
assert.equal(stateAfter('permission-request'), 'needs-you')
assert.equal(stateAfter('notification'), 'needs-you')
assert.equal(stateAfter('request-resolved'), 'working')
assert.equal(stateAfter('turn-completed'), 'idle')
assert.equal(stateAfter('session-ended'), null)
assert.equal(stateAfter('process-exited'), 'error')

// --- reducer: fresh session ---
let snap = reduceSnapshot(null, ev('session-started'))
assert.equal(snap.state, 'idle')
assert.equal(snap.since, 1000)

// first-ever event that freezes state defaults to idle
assert.equal(reduceSnapshot(null, ev('session-ended')).state, 'idle')

// --- reducer: since only moves on state change ---
snap = reduceSnapshot(snap, ev('prompt-submitted', { ts: 2000 }))
assert.equal(snap.state, 'working')
assert.equal(snap.since, 2000)

snap = reduceSnapshot(snap, ev('tool-call', { ts: 3000 }))
assert.equal(snap.state, 'working')
assert.equal(snap.since, 2000, 'same-state event must not reset since')
assert.equal(snap.lastEvent.ts, 3000, 'lastEvent must still refresh')

// --- reducer: session-ended freezes the current state ---
snap = reduceSnapshot(snap, ev('permission-request', { ts: 4000 }))
assert.equal(snap.state, 'needs-you')
snap = reduceSnapshot(snap, ev('session-ended', { ts: 5000 }))
assert.equal(snap.state, 'needs-you', 'session-ended must freeze, not reset')
assert.equal(snap.since, 4000)

// --- reducer: error path ---
snap = reduceSnapshot(snap, ev('process-exited', { ts: 6000 }))
assert.equal(snap.state, 'error')
assert.equal(snap.since, 6000)

// --- attention pulse: working → anything else, and nothing else (D5) ---
assert.equal(isAttentionTransition('working', 'needs-you'), true)
assert.equal(isAttentionTransition('working', 'idle'), true)
assert.equal(isAttentionTransition('working', 'error'), true)
assert.equal(isAttentionTransition('working', 'working'), false)
assert.equal(isAttentionTransition('idle', 'needs-you'), false)
assert.equal(isAttentionTransition('needs-you', 'idle'), false)
assert.equal(isAttentionTransition(null, 'working'), false)

// --- a structured boundary invalidates the older scraped caption ---
let live = reduceSnapshot(null, ev('prompt-submitted', { ts: 1000 }))
live = { ...live, liveStatus: 'Spelunking… (4s · ↓ 2 tokens)' }
live = reduceSnapshot(live, ev('tool-call', { ts: 2000 }))
assert.equal(live.liveStatus, null, 'a pre-tool spinner must not survive the tool boundary')
live = reduceSnapshot(live, ev('turn-completed', { ts: 3000 }))
assert.equal(live.liveStatus, null, 'spinner must not outlive the working state')

// A result remains the history event while its projected activity becomes the
// live session description.
const result = reduceSnapshot(null, ev('tool-result', {
    summary: 'web done',
    projectedActivity: { kind: 'thinking', summary: 'thinking' },
}))
assert.equal(result.lastEvent.kind, 'tool-result')
assert.equal(result.lastEvent.summary, 'web done')
assert.equal(result.activity.kind, 'thinking')
assert.equal(result.activity.summary, 'thinking')

// --- a second turn starts with no caption, so an identical one still shows ---
// Codex captions repeat verbatim between turns once the elapsed-time suffix is
// stripped. Adapters dedupe against this field, so it has to be clear again by
// the time the next turn starts working, or the repeat never publishes.
let turn = reduceSnapshot(null, ev('prompt-submitted', { ts: 1 }))
turn = { ...turn, liveStatus: 'Thinking' }
turn = reduceSnapshot(turn, ev('turn-completed', { ts: 2 }))
assert.equal(turn.liveStatus, null, 'caption clears when the turn ends')
turn = reduceSnapshot(turn, ev('prompt-submitted', { ts: 3 }))
assert.equal(turn.state, 'working', 'a later prompt works again')
assert.equal(turn.liveStatus, null, 'the new turn must not inherit the old caption')

// --- a turn whose terminating event never arrived. Hook delivery is a
// fire-and-forget curl, so it can be lost; the spinner going away is then the
// only remaining signal. Both guards have to hold. ---
const misses = SPINNER_MISSES_TO_END_TURN
const quiet = SPINNER_QUIET_MS_TO_END_TURN

assert.equal(spinnerAbsenceEndsTurn(misses, quiet, true), true, 'both thresholds met')
assert.equal(spinnerAbsenceEndsTurn(misses + 10, quiet + 10_000, true), true)

// One flaky read must not end a turn — claude repaints differentially and a poll
// can land mid-repaint.
assert.equal(spinnerAbsenceEndsTurn(1, quiet, true), false)
assert.equal(spinnerAbsenceEndsTurn(misses - 1, quiet, true), false, 'one poll short')

// The dangerous false positive: a prompt was just submitted and the first
// spinner frame has not been painted yet. Reading that as a finished turn would
// drop the session to idle the moment it started working.
assert.equal(spinnerAbsenceEndsTurn(misses, 0, true), false, 'prompt just submitted')
assert.equal(spinnerAbsenceEndsTurn(misses, quiet - 1, true), false, 'one ms short')
// ...which is the same guard that keeps a tool call alive, since every hook
// event restarts the quiet window.
assert.equal(spinnerAbsenceEndsTurn(100, 500, true), false, 'tool call reported 500ms ago')

// A submitted prompt can spend several seconds waiting for its first response
// without ever painting a spinner. Absence is only evidence that work ended
// after this exact working turn previously showed one.
assert.equal(
    spinnerAbsenceEndsTurn(misses + 100, quiet + 60_000, false),
    false,
    'never-observed spinner must not turn an in-flight prompt idle',
)

// --- summary clamp ---
assert.equal(clampSummary('  edit:   auth.ts  '), 'edit: auth.ts')
const long = clampSummary('bash: ' + 'x'.repeat(200))
assert.equal(long.length, SUMMARY_MAX_LENGTH)
assert.ok(long.endsWith('…'))

console.log('events.test.cjs: all assertions passed')
