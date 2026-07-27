const assert = require('node:assert/strict')
const { OpenCodeEventProjector } = require('../.test-build/opencodeEvents.js')

const projector = new OpenCodeEventProjector('vibby-1')
let ts = 100
const event = payload => projector.apply(payload, ts++)

// OpenCode 1.17.9 streams reasoning as an empty part registration followed
// by message.part.delta events. Waiting for the final part.updated means the
// thinking label arrives only when reasoning has already ended.
const streamingProjector = new OpenCodeEventProjector('vibby-stream')
let streamingTs = 1
const streamEvent = payload => streamingProjector.apply(payload, streamingTs++)

let streamed = streamEvent({
    type: 'message.part.updated',
    properties: {
        sessionID: 'stream-root',
        part: {
            id: 'reasoning-part',
            messageID: 'assistant-message',
            sessionID: 'stream-root',
            type: 'reasoning',
            text: '',
        },
    },
})
assert.equal(streamed, null, 'empty part registration is not visible by itself')

streamed = streamEvent({
    type: 'message.part.delta',
    properties: {
        sessionID: 'stream-root',
        messageID: 'assistant-message',
        partID: 'reasoning-part',
        field: 'text',
        delta: 'Checking the real event stream',
    },
})
assert.equal(streamed.kind, 'thinking')
assert.equal(streamed.summary, 'Checking the real event stream')
assert.equal(streamed.projectedState, 'working')

streamed = streamEvent({
    type: 'session.status',
    properties: { sessionID: 'stream-root', status: { type: 'busy' } },
})
assert.equal(
    streamed.kind,
    'prompt-submitted',
    'busy alone is only working; thinking requires an explicit reasoning signal',
)

const userMessage = {
    type: 'message.updated',
    properties: {
        sessionID: 'stream-root',
        info: { id: 'user-message', sessionID: 'stream-root', role: 'user' },
    },
}
assert.equal(streamEvent(userMessage).kind, 'prompt-submitted')
streamEvent({
    type: 'session.status',
    properties: { sessionID: 'stream-root', status: { type: 'idle' } },
})
assert.equal(
    streamEvent(userMessage),
    null,
    'OpenCode replaying an old user message after idle must not restart the session',
)

let e = event({ type: 'server.connected', properties: {} })
assert.equal(e.kind, 'session-started')
assert.equal(e.projectedState, 'idle')

e = event({
    type: 'session.created',
    properties: { info: { id: 'root' } },
})
assert.equal(e.projectedState, 'idle')

e = event({
    type: 'session.status',
    properties: { sessionID: 'root', status: { type: 'busy' } },
})
assert.equal(e.kind, 'prompt-submitted')
assert.equal(e.projectedState, 'working')

e = event({
    type: 'message.part.updated',
    properties: {
        part: {
            type: 'tool',
            sessionID: 'root',
            tool: 'read',
            state: { status: 'running', input: { filePath: 'C:\\repo\\src\\auth.ts' } },
        },
    },
})
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'read: auth.ts')
assert.equal(e.projectedState, 'working')

e = event({
    type: 'message.part.updated',
    properties: {
        part: {
            type: 'reasoning',
            sessionID: 'root',
            text: 'Checking authentication state',
        },
    },
})
assert.equal(e.kind, 'thinking')
assert.equal(e.summary, 'Checking authentication state')
assert.equal(e.projectedState, 'working')

e = event({
    type: 'message.part.updated',
    properties: {
        part: { type: 'reasoning', sessionID: 'root', text: '' },
        delta: 'Comparing the latest event payload',
    },
})
assert.equal(e.kind, 'thinking')
assert.equal(e.summary, 'Comparing the latest event payload')

e = event({
    type: 'message.part.updated',
    properties: {
        part: {
            type: 'reasoning',
            sessionID: 'root',
            text: 'Earlier analysis that should scroll away while the newest reasoning conclusion remains visible',
        },
    },
})
assert.equal(e.summary.length, 48)
assert.equal(e.summary.endsWith('newest reasoning conclusion remains visible'), true)

assert.equal(event({
    type: 'message.part.updated',
    properties: {
        part: { type: 'reasoning', sessionID: 'root', text: '' },
    },
}), null, 'empty reasoning lifecycle updates should not add feed noise')

// v1.17.9 name
e = event({
    type: 'permission.updated',
    properties: { id: 'perm-1', sessionID: 'root', title: 'Run bash' },
})
assert.equal(e.kind, 'permission-request')
assert.equal(e.projectedState, 'needs-you')

// A child becoming idle must not override a root permission.
event({
    type: 'session.created',
    properties: { info: { id: 'child', parentID: 'root' } },
})
e = event({
    type: 'session.idle',
    properties: { sessionID: 'child' },
})
assert.equal(e.projectedState, 'needs-you')

e = event({
    type: 'permission.replied',
    properties: { permissionID: 'perm-1', sessionID: 'root' },
})
assert.equal(e.kind, 'request-resolved')
assert.equal(e.projectedState, 'working')

// Current/dev name
e = event({
    type: 'question.asked',
    properties: {
        id: 'q-1',
        sessionID: 'child',
        questions: [{ header: 'Choose mode' }],
    },
})
assert.equal(e.kind, 'question-request')
assert.equal(e.summary, 'question: Choose mode')
assert.equal(e.projectedState, 'needs-you')

e = event({
    type: 'question.rejected',
    properties: { requestID: 'q-1', sessionID: 'child' },
})
assert.equal(e.projectedState, 'working')

e = event({
    type: 'session.status',
    properties: {
        sessionID: 'root',
        status: { type: 'retry', attempt: 2, message: 'Rate limited' },
    },
})
assert.equal(e.kind, 'retrying')
assert.equal(e.summary, 'retry #2 Rate limited')
assert.equal(e.projectedState, 'working')

e = event({
    type: 'session.status',
    properties: { sessionID: 'root', status: { type: 'idle' } },
})
assert.equal(e.projectedState, 'idle')

e = event({
    type: 'session.error',
    properties: { sessionID: 'root', error: { data: { message: 'Provider unavailable' } } },
})
assert.equal(e.kind, 'session-error')
assert.equal(e.summary, 'error: Provider unavailable')
assert.equal(e.projectedState, 'error')

// A new busy status clears the old error and wins over idle children.
e = event({
    type: 'session.status',
    properties: { sessionID: 'root', status: { type: 'busy' } },
})
assert.equal(e.projectedState, 'working')

e = projector.reconcileStatuses({
    root: { type: 'idle' },
    child: { type: 'busy' },
}, ts++)
assert.equal(e.projectedState, 'working')

assert.equal(event({ type: 'future.event', properties: {} }), null)
assert.equal(event({ invalid: true }), null)

console.log('opencodeEvents.test.cjs: all assertions passed')
