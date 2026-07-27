const assert = require('node:assert/strict')
const {
    CODEX_HOOK_ENDPOINT_ENV,
    CODEX_HOOK_EVENTS,
    CODEX_PROFILE_NAME,
    CodexHookProjector,
    codexHookProfile,
    translateCodexHook,
} = require('../.test-build/codexHooks.js')
const { buildWindowsCliShim } = require('../.test-build/terminalCliShim.js')

const profile = codexHookProfile()
// a profile document, not an inline `hooks={...}` override
assert.match(profile, /^\[hooks\]\n/)
assert.doesNotMatch(profile, /^hooks=/)
for (const event of CODEX_HOOK_EVENTS) {
    assert.match(profile, new RegExp(`^${event} = `, 'm'))
}
assert.match(profile, new RegExp(`\\$${CODEX_HOOK_ENDPOINT_ENV}`))
assert.match(profile, new RegExp(`\\$env:${CODEX_HOOK_ENDPOINT_ENV}`))
assert.doesNotMatch(profile, /timeout = (?!3\b)\d+/)
assert.doesNotMatch(profile, /127\.0\.0\.1|session-[0-9]/)
assert.match(CODEX_PROFILE_NAME, /^[A-Za-z0-9_-]+$/)

// The Windows handler must move bytes, not text: decoding stdin through the
// console code page corrupts every non-ASCII payload, and Stop carries the
// assistant's own message.
assert.doesNotMatch(profile, /\[Console\]::In\b/)
assert.match(profile, /OpenStandardInput/)
assert.match(profile, /-Body \$m\.ToArray\(\)/)

// The profile exists because argv could not carry this document intact: a
// backslash-escaped quote survives neither cmd's parser nor the CRT's. Nothing
// vibby injects for Codex may contain one.
const shim = buildWindowsCliShim(
    { command: 'C:\\codex.exe', launcher: 'exe', entry: { binaries: ['codex'] } },
    ['-p', CODEX_PROFILE_NAME, '--dangerously-bypass-hook-trust'],
    { VIBBY_CODEX_HOOK_ENDPOINT: 'http://127.0.0.1:1/vibby/abc/codex/s1' },
    ['features'],
)
assert.doesNotMatch(shim, /\\"/)

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
    prompt: 'fix the flaky test',
}).summary, 'user: fix the flaky test')
// a non-string prompt must not render as "undefined" or "[object Object]"
assert.equal(translated({ hook_event_name: 'UserPromptSubmit' }).summary, 'user: ')
assert.equal(translated({ hook_event_name: 'UserPromptSubmit', prompt: { a: 1 } }).summary, 'user: ')
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
assert.equal(translated({ hook_event_name: 'PreCompact' }).kind, 'tool-call')
assert.equal(translated({ hook_event_name: 'PostCompact' }).kind, 'tool-result')
assert.equal(translated({ hook_event_name: 'Stop' }).kind, 'turn-completed')
assert.equal(translated({ hook_event_name: 'SessionEnd', reason: 'other' }).kind, 'session-ended')
assert.equal(translated({ hook_event_name: 'Unknown' }), null)

for (const hookEvent of CODEX_HOOK_EVENTS) {
    assert.notEqual(translated({ hook_event_name: hookEvent })?.kind, 'thinking')
    // registering an event we then drop on the floor is a silent blind spot
    assert.ok(translated({ hook_event_name: hookEvent }), `${hookEvent} must translate`)
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
