// Unit tests for Pi hook payload translation and extension generation.
const assert = require('node:assert/strict')
const {
    PI_HOOK_ENDPOINT_ENV,
    PI_HOOK_DROP_DIR_ENV,
    PI_HOOK_SESSION_ENV,
    buildPiExtensionSource,
    piHookEnvironment,
    translatePiHook,
} = require('../.test-build/piHooks.js')

// --- environment generation ---
const nativeEnv = piHookEnvironment('http://127.0.0.1:1/vibby/abc/pi/s1')
assert.equal(nativeEnv[PI_HOOK_ENDPOINT_ENV], 'http://127.0.0.1:1/vibby/abc/pi/s1')
assert.equal(nativeEnv[PI_HOOK_DROP_DIR_ENV], undefined)
assert.equal(nativeEnv[PI_HOOK_SESSION_ENV], undefined)

const wslEnv = piHookEnvironment('http://127.0.0.1:1/vibby/abc/pi/s1', '/tmp/vibby-pi-drop-s1', 'session-1')
assert.equal(wslEnv[PI_HOOK_ENDPOINT_ENV], 'http://127.0.0.1:1/vibby/abc/pi/s1')
assert.equal(wslEnv[PI_HOOK_DROP_DIR_ENV], '/tmp/vibby-pi-drop-s1')
assert.equal(wslEnv[PI_HOOK_SESSION_ENV], 'session-1')
assert.match(wslEnv.WSLENV || '', new RegExp(`(^|:)${PI_HOOK_DROP_DIR_ENV}(/p)?(:|$)`))
assert.match(wslEnv.WSLENV || '', new RegExp(`(^|:)${PI_HOOK_SESSION_ENV}(/p)?(:|$)`))

const preservedWslEnv = piHookEnvironment('http://127.0.0.1:1/vibby/abc/pi/s1', '/tmp/drop', 's1', { WSLENV: 'EXISTING/p' })
assert.match(preservedWslEnv.WSLENV, /EXISTING\/p/)
assert.match(preservedWslEnv.WSLENV, new RegExp(PI_HOOK_DROP_DIR_ENV))

// --- generated extension source ---
const extension = buildPiExtensionSource('http://127.0.0.1:1/vibby/abc/pi/s1', '/tmp/drop', 's1')
assert.match(extension, /export default function/)
assert.match(extension, /pi\.on\("session_start"/)
assert.match(extension, /pi\.on\("input"/)
assert.match(extension, /pi\.on\("tool_call"/)
assert.match(extension, /pi\.on\("tool_result"/)
assert.match(extension, /pi\.on\("turn_end"/)
assert.match(extension, /pi\.on\("agent_end"/)
assert.match(extension, new RegExp(`process\.env\.${PI_HOOK_ENDPOINT_ENV}`))
assert.match(extension, new RegExp(`process\.env\.${PI_HOOK_DROP_DIR_ENV}`))
assert.match(extension, new RegExp(`process\.env\.${PI_HOOK_SESSION_ENV}`))
assert.match(extension, /writeFileSync/)
assert.match(extension, /renameSync/)
assert.match(extension, /\.json/)
assert.match(extension, /return \{ action: "continue" \}/, 'input hook must let Pi continue processing')
assert.doesNotMatch(extension, /127\.0\.0\.1|session-[0-9]/, 'endpoint must come from env, not baked into source')

// --- hook event mapping ---
const t = (payload) => translatePiHook('s1', payload, 42)

let e = t({ type: 'session_start', reason: 'new' })
assert.equal(e.kind, 'session-started')
assert.equal(e.confidence, 'high')
assert.equal(e.sessionId, 's1')
assert.equal(e.ts, 42)
assert.equal(e.raw, undefined, 'raw hook payloads must not be retained')
assert.equal(e.summary, 'ready')

e = t({ type: 'input', event: { text: 'fix the bug', source: 'user' } })
assert.equal(e.kind, 'prompt-submitted')
assert.equal(e.summary, 'user: fix the bug')
assert.equal(e.raw, undefined)
// extension-injected input should not be reported as a user prompt
assert.equal(t({ type: 'input', event: { text: 'fix the bug', source: 'extension' } }), null)
// a payload with no text must not render the string "undefined"
assert.equal(t({ type: 'input', event: { source: 'user' } }).summary, 'user: ')

e = t({ type: 'tool_call', event: { toolName: 'Bash', input: { command: 'npm test -- --token secret' } } })
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'command: npm')

e = t({ type: 'tool_call', event: { toolName: 'apply_patch', input: { file_path: 'C:\\repo\\src\\auth.ts' } } })
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'edit: auth.ts')

e = t({ type: 'tool_call', event: { toolName: 'Read', input: { file_path: '/home/u/notes.md' } } })
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'read: notes.md')

e = t({ type: 'tool_result', event: { toolName: 'Bash', content: 'secret output', isError: false } })
assert.equal(e.kind, 'tool-result')
assert.equal(e.summary, 'tool: Bash')

e = t({ type: 'turn_end' })
assert.equal(e.kind, 'turn-completed')
assert.equal(e.summary, 'done')

e = t({ type: 'agent_end' })
assert.equal(e.kind, 'session-ended')
assert.equal(e.summary, 'ended')

e = t({ type: 'session_shutdown' })
assert.equal(e.kind, 'session-ended')

// --- events we do not subscribe to / garbage → null ---
assert.equal(t({ type: 'unknown' }), null)
assert.equal(t({}), null)
assert.equal(t('not an object'), null)
assert.equal(t(null), null)

console.log('piHooks.test.cjs: all assertions passed')
