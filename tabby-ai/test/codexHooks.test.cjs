const assert = require('node:assert/strict')
const {
    CODEX_HOOK_ENDPOINT_ENV,
    CODEX_HOOK_EVENTS,
    CodexHookProjector,
    codexHookConfig,
    translateCodexHook,
} = require('../.test-build/codexHooks.js')

const config = codexHookConfig()
for (const event of CODEX_HOOK_EVENTS) {
    assert.match(config, new RegExp(`${event} =`))
}
assert.match(config, new RegExp(`\\$${CODEX_HOOK_ENDPOINT_ENV}`))
assert.match(config, new RegExp(`\\$env:${CODEX_HOOK_ENDPOINT_ENV}`))
assert.doesNotMatch(config, /timeout = (?!3\b)\d+/)
assert.doesNotMatch(config, /127\.0\.0\.1|session-[0-9]/)

const translated = (payload) => translateCodexHook('session-1', payload, 123)

assert.deepEqual(translated({ hook_event_name: 'SessionStart' }), {
    sessionId: 'session-1',
    ts: 123,
    confidence: 'high',
    kind: 'session-started',
    summary: 'ready',
})
assert.equal(translated({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'secret prompt',
}).summary, 'user')
assert.equal(translated({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'curl -H "Authorization: secret" https://example.com' },
}).summary, 'command: curl')
assert.equal(translated({
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { path: 'C:\\project\\src\\app.ts', patch: 'secret contents' },
}).summary, 'edit: app.ts')
assert.equal(translated({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
}).kind, 'permission-request')
assert.equal(translated({ hook_event_name: 'SubagentStart' }).kind, 'tool-call')
assert.equal(translated({ hook_event_name: 'SubagentStop' }).kind, 'tool-result')
assert.equal(translated({ hook_event_name: 'Stop' }).kind, 'turn-completed')
assert.equal(translated({ hook_event_name: 'SessionEnd', reason: 'other' }).kind, 'session-ended')
assert.equal(translated({ hook_event_name: 'Unknown' }), null)

for (const hookEvent of CODEX_HOOK_EVENTS) {
    assert.notEqual(translated({ hook_event_name: hookEvent })?.kind, 'thinking')
}

const projector = new CodexHookProjector('session-1')
const tool = {
    hook_event_name: 'PreToolUse',
    tool_use_id: 'tool-1',
    tool_name: 'Bash',
    tool_input: { command: 'pwd --secret private-value' },
}
assert.equal(projector.apply(tool, 1).kind, 'tool-call')
assert.equal(projector.apply(tool, 2), null, 'approval retry must not duplicate a tool')
assert.equal(projector.apply({
    ...tool,
    hook_event_name: 'PermissionRequest',
}, 3).kind, 'permission-request')
assert.equal(projector.apply({
    ...tool,
    hook_event_name: 'PermissionRequest',
}, 4), null, 'permission callback must be idempotent')
assert.equal(projector.apply({
    ...tool,
    hook_event_name: 'PostToolUse',
}, 5).kind, 'tool-result')
assert.equal(projector.apply({
    ...tool,
    hook_event_name: 'PostToolUse',
}, 6), null, 'completion callback must be idempotent')
assert.doesNotMatch(JSON.stringify(projector.apply({
    hook_event_name: 'Stop',
    last_assistant_message: 'private response',
}, 7)), /private response/)

console.log('codexHooks.test.cjs: all assertions passed')
