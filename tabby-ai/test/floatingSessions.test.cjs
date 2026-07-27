// Public seam tests for the floating-session projection.
// The UI and Electron hub both consume these pure functions.
const assert = require('node:assert/strict')
const {
    mergeFloatingSessionSources,
    normalizeFloatingSessionSource,
    sortFloatingSessions,
    visibleFloatingSessions,
} = require('../.test-build/floatingSessions.js')

const session = (sessionId, lastActivityAt, createdAt = lastActivityAt) => ({
    sessionId,
    sourceWindowId: 1,
    kind: 'codex',
    name: sessionId,
    state: 'working',
    stateLabel: 'Working',
    summary: `event:${sessionId}`,
    createdAt,
    lastActivityAt,
})

const input = [
    session('older', 100),
    session('newest', 400),
    session('same-newer-created', 200, 300),
    session('same-older-created', 200, 250),
]

assert.deepEqual(
    sortFloatingSessions(input).map(x => x.sessionId),
    ['newest', 'same-newer-created', 'same-older-created', 'older'],
    'latest meaningful activity wins, then creation time',
)
assert.deepEqual(
    input.map(x => x.sessionId),
    ['older', 'newest', 'same-newer-created', 'same-older-created'],
    'sorting must not mutate the source snapshot',
)
assert.deepEqual(
    visibleFloatingSessions(input, false).map(x => x.sessionId),
    ['newest', 'same-newer-created', 'same-older-created'],
    'collapsed mode exposes exactly the three most recently active sessions',
)
assert.deepEqual(
    visibleFloatingSessions(input, true).map(x => x.sessionId),
    ['newest', 'same-newer-created', 'same-older-created', 'older'],
    'expanded mode exposes every session in the same ordering',
)

const normalized = normalizeFloatingSessionSource({
    sourceWindowId: 7,
    enabled: true,
    colorScheme: 'light',
    sessions: [{
        ...session('bounded', 500),
        sourceWindowId: 999,
        name: 'n'.repeat(200),
        summary: 's'.repeat(300),
    }],
})
assert.equal(normalized.sourceWindowId, 7)
assert.equal(normalized.sessions[0].sourceWindowId, 7, 'payload cannot spoof a per-session window')
assert.equal(normalized.sessions[0].name.length, 120)
assert.equal(normalized.sessions[0].summary.length, 160)
assert.equal(normalized.colorScheme, 'light')
assert.equal(normalized.enabled, true)

assert.equal(
    normalizeFloatingSessionSource({ sourceWindowId: 0, enabled: true, colorScheme: 'dark', sessions: [] }),
    null,
    'window ids must be positive integers',
)
assert.equal(
    normalizeFloatingSessionSource({
        sourceWindowId: 1,
        enabled: true,
        colorScheme: 'dark',
        sessions: [{ ...session('bad-state', 1), state: 'surprise' }],
    }),
    null,
    'unknown states fail closed at the IPC boundary',
)

const sourceA = normalizeFloatingSessionSource({
    sourceWindowId: 1,
    enabled: true,
    colorScheme: 'dark',
    sessions: [session('window-a', 20), session('collision', 30)],
})
const sourceB = normalizeFloatingSessionSource({
    sourceWindowId: 2,
    enabled: true,
    colorScheme: 'dark',
    sessions: [session('window-b', 40), session('collision', 50)],
})
assert.deepEqual(
    mergeFloatingSessionSources([sourceA, sourceB]).map(x => x.sessionId),
    ['window-b', 'window-a'],
    'cross-window aggregation keeps unique sessions and fails closed on identity collisions',
)

console.log('floatingSessions.test.cjs: all assertions passed')
