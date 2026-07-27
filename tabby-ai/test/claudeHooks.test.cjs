// Unit tests for Claude Code hook payload translation (plan §1 summary rules).
const assert = require('node:assert/strict')
const { summaryForToolCall, translateClaudeHook } = require('../.test-build/claudeHooks.js')

// --- summary extraction table ---
assert.equal(summaryForToolCall('Edit', { file_path: 'C:\\repo\\src\\auth.ts' }), 'edit: auth.ts')
assert.equal(summaryForToolCall('Write', { file_path: '/home/u/notes.md' }), 'edit: notes.md')
assert.equal(summaryForToolCall('Read', { file_path: 'a/b/config.yaml' }), 'read: config.yaml')
assert.equal(summaryForToolCall('Bash', { command: 'npm test -- --token secret' }), 'command: npm')
assert.equal(summaryForToolCall('Grep', { pattern: 'private customer data' }), 'search')
assert.equal(summaryForToolCall('Task', { description: 'private user request' }), 'agent')
assert.equal(summaryForToolCall('SomeNewTool', {}), 'somenewtool')
assert.equal(summaryForToolCall('Bash', undefined), 'command: command')

// --- hook event mapping ---
const t = (payload) => translateClaudeHook('s1', payload, 42)

let e = t({ hook_event_name: 'SessionStart', session_id: 'abc', model: 'claude-sonnet-5' })
assert.equal(e.kind, 'session-started')
assert.equal(e.confidence, 'high')
assert.equal(e.sessionId, 's1')
assert.equal(e.ts, 42)
assert.equal(e.raw, undefined, 'raw hook payloads must not be retained')

// The prompt is what makes a timeline row worth reading — a wall of bare `user`
// rows cannot tell you which session was doing what.
e = t({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' })
assert.equal(e.kind, 'prompt-submitted')
assert.equal(e.summary, 'user: fix the bug')
assert.equal(e.raw, undefined, 'raw hook payloads must not be retained')
// a payload with no prompt must not render the string "undefined"
assert.equal(t({ hook_event_name: 'UserPromptSubmit' }).summary, 'user: ')

e = t({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'command: ls')

e = t({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
assert.equal(e.kind, 'permission-request')

e = t({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' })
assert.equal(e.kind, 'notification')

e = t({ hook_event_name: 'Stop' })
assert.equal(e.kind, 'turn-completed')

e = t({ hook_event_name: 'SessionEnd', reason: 'logout' })
assert.equal(e.kind, 'session-ended')
assert.equal(e.summary, 'ended: logout')

// --- events we do not subscribe to / garbage → null ---
assert.equal(t({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), null)
assert.equal(t({ hook_event_name: 'PreCompact' }), null)
assert.equal(t({}), null)
assert.equal(t('not an object'), null)
assert.equal(t(null), null)

console.log('claudeHooks.test.cjs: all assertions passed')
