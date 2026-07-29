// Unit tests for Claude Code hook payload translation (plan §1 summary rules).
const assert = require('node:assert/strict')
const {
    CLAUDE_HOOK_EVENTS,
    CLAUDE_HOOK_SESSION_ENV,
    CLAUDE_HOOK_TEMP_ENV,
    ClaudeHookProjector,
    claudeHookRecovery,
    summaryForToolCall,
    translateClaudeHook,
} = require('../.test-build/claudeHooks.js')

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

e = t({
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude needs a decision',
})
assert.equal(e.kind, 'permission-request')

e = t({
    hook_event_name: 'Notification',
    notification_type: 'elicitation_dialog',
    message: 'Please fill in the MCP form',
})
assert.equal(e.kind, 'question-request')

e = t({
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    message: 'Claude is waiting for your input',
})
assert.equal(e.kind, 'turn-completed')

assert.equal(t({
    hook_event_name: 'Notification',
    notification_type: 'auth_success',
    message: 'Authentication succeeded',
}), null, 'non-actionable notifications must not ask for attention')

// Older Claude payloads did not include notification_type.
e = t({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
assert.equal(e.kind, 'permission-request')

e = t({ hook_event_name: 'Stop' })
assert.equal(e.kind, 'turn-completed')

e = t({ hook_event_name: 'PostToolUse', tool_name: 'WebSearch', tool_use_id: 'web-1' })
assert.equal(e.kind, 'tool-result')
assert.equal(e.summary, 'web done')

e = t({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
})
assert.equal(e.kind, 'tool-result')
assert.equal(e.summary, 'command: npm failed')

e = t({ hook_event_name: 'PostToolBatch' })
assert.equal(e.kind, 'thinking')

e = t({ hook_event_name: 'StopFailure', error: 'rate_limit' })
assert.equal(e.kind, 'session-error')
assert.equal(e.summary, 'error: rate_limit')

e = t({ hook_event_name: 'SessionEnd', reason: 'logout' })
assert.equal(e.kind, 'session-ended')
assert.equal(e.summary, 'ended: logout')
assert.equal(e.projectedState, 'idle')

// --- events we do not subscribe to / garbage → null ---
assert.equal(t({}), null)
assert.equal(t('not an object'), null)
assert.equal(t(null), null)

for (const required of [
    'PostToolUse',
    'PostToolUseFailure',
    'PostToolBatch',
    'PermissionRequest',
    'PermissionDenied',
    'StopFailure',
]) {
    assert.ok(CLAUDE_HOOK_EVENTS.includes(required), `${required} must be injected`)
}

// --- stateful lifecycle projection ---
const projector = new ClaudeHookProjector('s1')
assert.equal(projector.apply({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/a.ts' },
    tool_use_id: 'read-1',
}, 1).summary, 'read: a.ts')
assert.equal(projector.hasActiveTools, true)

assert.equal(projector.apply({
    hook_event_name: 'PreToolUse',
    tool_name: 'WebSearch',
    tool_use_id: 'web-1',
}, 2).summary, 'web')

let projected = projector.apply({
    hook_event_name: 'PostToolUse',
    tool_name: 'WebSearch',
    tool_use_id: 'web-1',
}, 3)
assert.equal(projected.kind, 'tool-result')
assert.deepEqual(
    projected.projectedActivity,
    { kind: 'tool-call', summary: 'read: a.ts' },
    'finishing one parallel tool keeps the other visible',
)
assert.equal(projector.hasActiveTools, true)
assert.equal(projector.apply({
    hook_event_name: 'PostToolUse',
    tool_name: 'WebSearch',
    tool_use_id: 'web-1',
}, 4), null, 'duplicate results are ignored')

projected = projector.apply({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/a.ts' },
    tool_use_id: 'read-1',
}, 5)
assert.deepEqual(projected.projectedActivity, { kind: 'thinking', summary: 'thinking' })
assert.equal(projector.hasActiveTools, false)

projected = projector.apply({ hook_event_name: 'PostToolBatch' }, 6)
assert.equal(projected.kind, 'thinking')
assert.deepEqual(projected.projectedActivity, { kind: 'thinking', summary: 'thinking' })

projector.apply({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 'bash-1',
}, 7)
projected = projector.apply({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 'bash-1',
    is_interrupt: true,
}, 8)
assert.equal(projected.kind, 'turn-completed')
assert.equal(projected.summary, 'interrupted')
assert.equal(projected.projectedState, 'idle')

projector.apply({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: 'agent-tool',
}, 9)
projected = projector.apply({
    hook_event_name: 'Stop',
    background_tasks: [{ id: 'bg-1', type: 'subagent', status: 'running' }],
}, 10)
assert.equal(projected.kind, 'tool-call')
assert.equal(projected.projectedState, 'working')
assert.equal(projected.summary, 'agent')
assert.equal(projector.apply({
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_use_id: 'agent-tool',
}, 11), null, 'late result after Stop cannot reopen a closed turn')

projected = projector.apply({
    hook_event_name: 'Notification',
    notification_type: 'elicitation_response',
}, 12)
assert.equal(projected.kind, 'request-resolved')
assert.deepEqual(projected.projectedActivity, { kind: 'thinking', summary: 'thinking' })

// --- renderer recovery markers are non-secret and strictly validated ---
assert.deepEqual(claudeHookRecovery({
    [CLAUDE_HOOK_SESSION_ENV]: 'session-1',
    [CLAUDE_HOOK_TEMP_ENV]: 'vibby-hooks-Ab12Cd',
}), {
    sessionId: 'session-1',
    tempName: 'vibby-hooks-Ab12Cd',
})
assert.equal(claudeHookRecovery({
    [CLAUDE_HOOK_SESSION_ENV]: '../escape',
    [CLAUDE_HOOK_TEMP_ENV]: 'vibby-hooks-Ab12Cd',
}), null)
assert.equal(claudeHookRecovery({
    [CLAUDE_HOOK_SESSION_ENV]: 'session-1',
    [CLAUDE_HOOK_TEMP_ENV]: 'vibby-hooks-not-ours',
}), null)

console.log('claudeHooks.test.cjs: all assertions passed')
