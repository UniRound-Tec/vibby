// Unit tests for Kimi Code hook translation + temp-home helpers.
const assert = require('node:assert/strict')
const {
    KIMI_HOOK_EVENTS,
    KIMI_HOOK_SESSION_ENV,
    KIMI_HOOK_TEMP_ENV,
    KIMI_CODE_HOME_ENV,
    KIMI_TEMP_DIR_PREFIX,
    buildKimiConfigToml,
    escapeTomlBasicString,
    kimiCurlHookCommand,
    kimiHookEnvironment,
    kimiHookRecovery,
    summaryForKimiToolCall,
    translateKimiHook,
    withoutStaleKimiHookEnv,
} = require('../.test-build/kimiHooks.js')

assert.ok(KIMI_HOOK_EVENTS.includes('SessionStart'))
assert.ok(KIMI_HOOK_EVENTS.includes('PermissionRequest'))
assert.ok(KIMI_HOOK_EVENTS.includes('Interrupt'))

assert.equal(summaryForKimiToolCall('Edit', { file_path: 'C:\\repo\\src\\auth.ts' }), 'edit: auth.ts')
assert.equal(summaryForKimiToolCall('Read', { file_path: 'a/b/config.yaml' }), 'read: config.yaml')
assert.equal(summaryForKimiToolCall('Bash', { command: 'npm test -- --token secret' }), 'command: npm')
assert.equal(summaryForKimiToolCall('Shell', { command: 'ls' }), 'command: ls')
assert.equal(summaryForKimiToolCall('Grep', { pattern: 'x' }), 'search')
assert.equal(summaryForKimiToolCall('SomeNewTool', {}), 'somenewtool')

const t = (payload) => translateKimiHook('s1', payload, 42)

let e = t({ hook_event_name: 'SessionStart', session_id: 'abc' })
assert.equal(e.kind, 'session-started')
assert.equal(e.confidence, 'high')
assert.equal(e.sessionId, 's1')
assert.equal(e.ts, 42)

e = t({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' })
assert.equal(e.kind, 'prompt-submitted')
assert.equal(e.summary, 'user: fix the bug')
assert.equal(e.projectedActivity, undefined)

// Kimi ships prompt as ContentPart[], not a string.
e = t({
    hook_event_name: 'UserPromptSubmit',
    prompt: [{ type: 'text', text: 'say hi in one word only' }],
})
assert.equal(e.kind, 'prompt-submitted')
assert.equal(e.summary, 'user: say hi in one word only')

const {
    contentPartsText,
} = require('../.test-build/kimiHooks.js')
assert.equal(contentPartsText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a b')
assert.equal(contentPartsText('plain'), 'plain')
assert.equal(contentPartsText([]), '')
assert.equal(contentPartsText(null), '')

e = t({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'command: ls')

e = t({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })
assert.equal(e.kind, 'permission-request')
assert.equal(e.summary, 'approve: Bash')

e = t({ hook_event_name: 'PermissionResult', tool_name: 'Bash' })
assert.equal(e.kind, 'request-resolved')

e = t({ hook_event_name: 'Stop' })
assert.equal(e.kind, 'turn-completed')

e = t({ hook_event_name: 'Interrupt', reason: 'user' })
assert.equal(e.kind, 'turn-completed')
assert.equal(e.summary, 'user')
assert.equal(e.projectedState, 'idle')

e = t({ hook_event_name: 'StopFailure', error: 'boom' })
assert.equal(e.kind, 'session-error')
assert.equal(e.summary, 'error: boom')

e = t({ hook_event_name: 'SessionEnd', reason: 'exit' })
assert.equal(e.kind, 'session-ended')
assert.equal(e.projectedState, 'idle')

e = t({
    hook_event_name: 'Notification',
    notification_type: 'task.completed',
    message: 'Background task finished',
})
assert.equal(e.kind, 'turn-completed')

e = t({
    hook_event_name: 'Notification',
    type: 'permission',
    message: 'Need approval',
})
assert.equal(e.kind, 'permission-request')

assert.equal(t({ hook_event_name: 'UnknownEvent' }), null)
assert.equal(t(null), null)

assert.equal(escapeTomlBasicString('a"b\\c'), 'a\\"b\\\\c')

const toml = buildKimiConfigToml('default_model = "kimi-code/k3"\n', 'echo vibby')
assert.match(toml, /default_model = "kimi-code\/k3"/)
assert.match(toml, /\[\[hooks\]\]/)
assert.match(toml, /event = "SessionStart"/)
assert.match(toml, /command = "echo vibby"/)
assert.match(toml, /timeout = 5/)
assert.equal(
    (toml.match(/\[\[hooks\]\]/g) || []).length,
    KIMI_HOOK_EVENTS.length,
)

const onlyHooks = buildKimiConfigToml('', 'drop-cmd')
assert.doesNotMatch(onlyHooks, /default_model/)
assert.match(onlyHooks, /command = "drop-cmd"/)

assert.equal(
    kimiCurlHookCommand('/mnt/c/Windows/System32/curl.exe', 'http://127.0.0.1:9/vibby/x/kimi/s'),
    "'/mnt/c/Windows/System32/curl.exe' -s -m 3 --data-binary @- 'http://127.0.0.1:9/vibby/x/kimi/s'",
)

assert.equal(kimiHookRecovery({}), null)
assert.equal(kimiHookRecovery({
    [KIMI_HOOK_SESSION_ENV]: 'bad id',
    [KIMI_HOOK_TEMP_ENV]: `${KIMI_TEMP_DIR_PREFIX}abcdef`,
}), null)
assert.deepEqual(kimiHookRecovery({
    [KIMI_HOOK_SESSION_ENV]: 'session-1',
    [KIMI_HOOK_TEMP_ENV]: `${KIMI_TEMP_DIR_PREFIX}abcdef`,
}), { sessionId: 'session-1', tempName: `${KIMI_TEMP_DIR_PREFIX}abcdef` })

const cleaned = withoutStaleKimiHookEnv({
    FOO: '1',
    [KIMI_CODE_HOME_ENV]: '/tmp/x',
    [KIMI_HOOK_SESSION_ENV]: 's',
    [KIMI_HOOK_TEMP_ENV]: 't',
})
assert.deepEqual(cleaned, { FOO: '1' })

const env = kimiHookEnvironment('/tmp/home', 'sid', `${KIMI_TEMP_DIR_PREFIX}abcdef`, { FOO: '1' })
assert.equal(env[KIMI_CODE_HOME_ENV], '/tmp/home')
assert.equal(env[KIMI_HOOK_SESSION_ENV], 'sid')
assert.equal(env.FOO, '1')

const wslEnv = kimiHookEnvironment('/mnt/c/tmp/home', 'sid', `${KIMI_TEMP_DIR_PREFIX}abcdef`, {}, { wsl: true })
assert.match(wslEnv.WSLENV, new RegExp(KIMI_CODE_HOME_ENV))

console.log('kimiHooks.test.cjs: all assertions passed')
