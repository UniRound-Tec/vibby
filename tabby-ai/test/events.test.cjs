// Unit tests for the pure event protocol module (docs/06-m2-plan.md §5 WP0).
// Run via `yarn test` in tabby-ai/ — compiles src/events.ts alone with the
// repo's tsc, then asserts against the CJS output. No test framework.
const assert = require('node:assert/strict')
const {
    SUMMARY_MAX_LENGTH,
    clampSummary,
    stateAfter,
    reduceSnapshot,
    isAttentionTransition,
} = require('../.test-build/events.js')

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
assert.equal(stateAfter('permission-request'), 'needs-you')
assert.equal(stateAfter('notification'), 'needs-you')
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

// --- summary clamp ---
assert.equal(clampSummary('  edit:   auth.ts  '), 'edit: auth.ts')
const long = clampSummary('bash: ' + 'x'.repeat(200))
assert.equal(long.length, SUMMARY_MAX_LENGTH)
assert.ok(long.endsWith('…'))

console.log('events.test.cjs: all assertions passed')
