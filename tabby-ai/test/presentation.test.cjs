// Unit tests for the shared session-presentation module.
// Run via `yarn test` in tabby-ai/ — see events.test.cjs for the pattern.
const assert = require('node:assert/strict')
const {
    DISPLAY_STATE_RANK,
    displayStateFor,
    stateLabelKey,
    activityLabelKey,
    captionFor,
    lastEventCaptionFor,
    loudest,
} = require('../.test-build/presentation.js')

const facts = (o = {}) => ({ snapshot: null, sessionId: null, runtimeDetected: false, ...o })
const snap = (state, o = {}) => ({ sessionId: 's', state, since: 0, lastEvent: null, ...o })

// --- display state: the plumbing states only apply before the first event ---
assert.equal(displayStateFor(facts()), 'untracked', 'nothing monitoring it')
assert.equal(displayStateFor(facts({ sessionId: 's' })), 'listening', 'armed, no events yet')
assert.equal(displayStateFor(facts({ sessionId: 's', snapshot: snap('working') })), 'working')
// a snapshot outranks the plumbing even with no session id
assert.equal(displayStateFor(facts({ snapshot: snap('error') })), 'error')

// --- visible activity label: preserve the coarse state for ordering, but show thinking ---
const thinking = facts({
    sessionId: 's',
    snapshot: snap('working', {
        lastEvent: { kind: 'thinking', summary: 'Checking authentication state' },
    }),
})
assert.equal(activityLabelKey(thinking), 'Thinking')
assert.equal(displayStateFor(thinking), 'working', 'thinking must not become a fifth state')
assert.equal(
    activityLabelKey(facts({
        sessionId: 's',
        snapshot: snap('working', { lastEvent: { kind: 'tool-call', summary: 'read: auth.ts' } }),
    })),
    'Working',
)

// --- ordering: worst first, and error above merely-busy ---
const order = Object.entries(DISPLAY_STATE_RANK).sort((a, b) => a[1] - b[1]).map(([k]) => k)
assert.deepEqual(order, ['needs-you', 'error', 'working', 'idle', 'listening', 'untracked'])
assert.ok(
    DISPLAY_STATE_RANK.error < DISPLAY_STATE_RANK.idle,
    'a session that died must not sort below an idle one',
)

// --- every display state has a label ---
for (const state of order) {
    assert.equal(typeof stateLabelKey(state), 'string')
    assert.ok(stateLabelKey(state).length, `${state} has no label`)
}

// --- caption: the rail merges the two channels, the dashboard does not ---
const working = facts({
    sessionId: 's',
    snapshot: snap('working', { lastEvent: { summary: 'edit: auth.ts' }, liveStatus: 'Flambéing… (17s)' }),
})
assert.deepEqual(captionFor(working), { text: 'Flambéing… (17s)' }, 'rail: fresher wins')
assert.deepEqual(
    lastEventCaptionFor(working),
    { text: 'edit: auth.ts' },
    'dashboard: keeps the event line, it shows liveStatus separately',
)

// falls back to the last event when the spinner is not running
const idle = facts({ sessionId: 's', snapshot: snap('idle', { lastEvent: { summary: 'done' } }) })
assert.deepEqual(captionFor(idle), { text: 'done' })

// --- silence has a reason, and it is translatable ---
const reason = f => {
    const c = captionFor(f)
    assert.ok('key' in c, 'a session with no events must explain itself')
    return c.key
}
const launched = reason(facts())
const armed = reason(facts({ sessionId: 's' }))
const spotted = reason(facts({ runtimeDetected: true }))
assert.notEqual(launched, armed)
assert.notEqual(armed, spotted)
assert.notEqual(launched, spotted)
// an armed session reports as armed even if it was also spotted in a terminal
assert.equal(reason(facts({ sessionId: 's', runtimeDetected: true })), armed)
// both callers give the same reason for the same silence
assert.deepEqual(captionFor(facts({ sessionId: 's' })), lastEventCaptionFor(facts({ sessionId: 's' })))

// a snapshot with no event text is blank, not a fallback message
assert.deepEqual(captionFor(facts({ sessionId: 's', snapshot: snap('idle') })), { text: '' })

// --- loudest ---
const pick = states => loudest(states, s => s)
assert.equal(pick(['idle', 'needs-you', 'working']), 'needs-you')
assert.equal(pick(['idle', 'error']), 'error')
assert.equal(pick(['idle', 'working']), 'working')
assert.equal(pick([]), null)
assert.equal(pick(['untracked']), 'untracked')

console.log('presentation.test.cjs: all assertions passed')
