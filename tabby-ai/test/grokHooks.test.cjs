const assert = require('node:assert/strict')

const {
    GROK_HOOK_EVENTS,
    GROK_HOOK_SESSION_ENV,
    GROK_HOOK_DROP_ENV,
    GROK_HOOK_ENDPOINT_ENV,
    buildGrokHookConfig,
    buildGrokHookScript,
    buildGrokHookScriptCmd,
    buildGrokHookScriptPs1,
    grokHookEnvironment,
    grokHookRecovery,
    grokPromptText,
    summaryForGrokToolCall,
    translateGrokHook,
    withoutStaleGrokHookEnv,
} = require('../.test-build/grokHooks.js')

// --- event list -------------------------------------------------------------

assert.equal(GROK_HOOK_EVENTS.length, 14)
assert.ok(GROK_HOOK_EVENTS.includes('SessionStart'))
assert.ok(GROK_HOOK_EVENTS.includes('PermissionDenied'))
assert.ok(GROK_HOOK_EVENTS.includes('PreCompact'))
// grok has no Interrupt event, and no PermissionRequest/PermissionResult pair
assert.ok(!GROK_HOOK_EVENTS.includes('Interrupt'))
assert.ok(!GROK_HOOK_EVENTS.includes('PermissionRequest'))

// --- tool summaries ---------------------------------------------------------

// grok's own vocabulary, not Claude's
assert.equal(summaryForGrokToolCall('run_terminal_command', { command: 'echo hello-vibby' }), 'command: echo')
assert.equal(summaryForGrokToolCall('read_file', { target_file: '/tmp/p/probe.sh', limit: 5 }), 'read: probe.sh')
assert.equal(summaryForGrokToolCall('search_replace', { target_file: 'C:\\repo\\src\\auth.ts' }), 'edit: auth.ts')
assert.equal(summaryForGrokToolCall('create_file', { target_file: '/repo/new.ts' }), 'edit: new.ts')
assert.equal(summaryForGrokToolCall('grep', {}), 'search')
assert.equal(summaryForGrokToolCall('list_dir', {}), 'search')
assert.equal(summaryForGrokToolCall('web_fetch', {}), 'web')
assert.equal(summaryForGrokToolCall('spawn_subagent', {}), 'agent')
assert.equal(summaryForGrokToolCall('todo_write', {}), 'todo')
// a Claude-shaped key must still resolve, but target_file wins when both exist
assert.equal(summaryForGrokToolCall('read_file', { file_path: '/a/b.ts' }), 'read: b.ts')
assert.equal(summaryForGrokToolCall('read_file', { target_file: '/a/win.ts', file_path: '/a/lose.ts' }), 'read: win.ts')
// long shell commands are truncated to the leading binary, so secrets in
// arguments never reach the summary
assert.equal(summaryForGrokToolCall('run_terminal_command', { command: 'npm test -- --token secret' }), 'command: npm')
// MCP calls arrive fully qualified
assert.equal(summaryForGrokToolCall('linear__save_issue', {}), 'linear: save_issue')
assert.equal(summaryForGrokToolCall('', {}), 'tool')

// --- prompt unwrapping ------------------------------------------------------

assert.equal(grokPromptText('<user_query>\nfix the bug\n</user_query>'), 'fix the bug')
assert.equal(grokPromptText('plain prompt'), 'plain prompt')
assert.equal(grokPromptText(undefined), '')

// --- translation ------------------------------------------------------------

const t = (payload) => translateGrokHook('s1', payload, 42)

// Fixtures below are verbatim captures from grok 0.2.114 (trimmed), so the
// camelCase keys and snake_case event values are the real wire shapes.

const started = t({
    hookEventName: 'session_start',
    sessionId: '019fae27-98f8-7793-997b-98c738a7a969',
    cwd: '/tmp/p',
    workspaceRoot: '/tmp/p/',
    permissionMode: 'bypassPermissions',
    source: 'new',
})
assert.deepEqual(started, {
    sessionId: 's1', ts: 42, confidence: 'high', kind: 'session-started', summary: 'ready',
})

assert.deepEqual(t({
    hookEventName: 'user_prompt_submit',
    prompt: '<user_query>\nRun the shell command: echo hello-vibby.\n</user_query>',
}), {
    sessionId: 's1', ts: 42, confidence: 'high',
    kind: 'prompt-submitted',
    summary: 'user: Run the shell command: echo hello-vibby.',
})

assert.deepEqual(t({
    hookEventName: 'pre_tool_use',
    toolName: 'run_terminal_command',
    toolUseId: 'call-x-0',
    toolInput: { command: 'echo hello-vibby', description: 'Echo hello-vibby to stdout' },
    toolInputTruncated: false,
}), {
    sessionId: 's1', ts: 42, confidence: 'high', kind: 'tool-call', summary: 'command: echo',
})

// ask_user_question parks the turn on the human — it must not read as `working`
assert.deepEqual(t({ hookEventName: 'pre_tool_use', toolName: 'ask_user_question', toolInput: {} }), {
    sessionId: 's1', ts: 42, confidence: 'high', kind: 'question-request', summary: 'question',
})

assert.equal(t({ hookEventName: 'post_tool_use', toolName: 'read_file', toolInput: { target_file: '/a/b.ts' } }).summary, 'read: b.ts done')
assert.equal(t({ hookEventName: 'post_tool_use', toolName: 'read_file', toolInput: { target_file: '/a/b.ts' } }).kind, 'tool-result')
assert.equal(t({ hookEventName: 'post_tool_use_failure', toolName: 'grep', toolInput: {} }).summary, 'search failed')

// the byte-array tool output must never leak into the summary
const posted = t({
    hookEventName: 'post_tool_use',
    toolName: 'run_terminal_command',
    toolInput: { command: 'echo hello-vibby' },
    toolResult: { type: 'Bash', output: [104, 105], output_for_prompt: 'exit: 0\nhi\n', exit_code: 0 },
})
assert.equal(posted.summary, 'command: echo done')
assert.equal(posted.raw, undefined)

// PermissionDenied is the answer, not the question
assert.deepEqual(t({ hookEventName: 'permission_denied', toolName: 'run_terminal_command' }), {
    sessionId: 's1', ts: 42, confidence: 'high', kind: 'request-resolved', summary: 'denied: run_terminal_command',
})

// --- the two-Stop trap ------------------------------------------------------

// The genuine turn end.
assert.deepEqual(t({
    hookEventName: 'stop',
    reason: 'end_turn',
    stopHookActive: false,
    lastAssistantMessage: '**Shell command**',
    backgroundTasks: [],
    sessionCrons: [],
}), {
    sessionId: 's1', ts: 42, confidence: 'high', kind: 'turn-completed', summary: 'done',
})

// The observation-only fire that lands ~15ms later at session end. Emitting it
// would post a phantom "done" after the session has already ended.
assert.equal(t({ hookEventName: 'stop', reason: 'shutdown', stopHookActive: false }), null)
assert.equal(t({ hookEventName: 'stop', reason: 'channel_closed' }), null)
assert.equal(t({ hookEventName: 'stop' }), null)

assert.deepEqual(t({ hookEventName: 'stop_failure', error: 'rate_limit' }), {
    sessionId: 's1', ts: 42, confidence: 'high', kind: 'session-error', summary: 'error: rate_limit',
})
assert.equal(t({ hookEventName: 'stop_failure' }).summary, 'error: unknown')

// --- compaction, subagents, session end -------------------------------------

assert.deepEqual(t({ hookEventName: 'pre_compact' }), {
    sessionId: 's1', ts: 42, confidence: 'high', kind: 'tool-call', summary: 'compacting',
})
assert.equal(t({ hookEventName: 'post_compact' }).summary, 'compacted')
assert.equal(t({ hookEventName: 'subagent_start' }).summary, 'agent')
assert.equal(t({ hookEventName: 'subagent_stop' }).summary, 'agent done')

const ended = t({ hookEventName: 'session_end', reason: 'shutdown' })
assert.equal(ended.kind, 'session-ended')
assert.equal(ended.summary, 'ended: shutdown')
assert.equal(ended.projectedState, 'idle')

// --- notifications ----------------------------------------------------------

// Verbatim capture: this is grok's only attention signal, and the type is
// `permission_prompt` — not the `approval_required` name the config docs use
// for the separate desktop-notification surface.
assert.deepEqual(t({
    hookEventName: 'notification',
    notificationType: 'permission_prompt',
    message: 'Tool permission requested',
    level: 'info',
}), {
    sessionId: 's1', ts: 42, confidence: 'high',
    kind: 'permission-request',
    summary: 'Tool permission requested',
})

assert.equal(t({ hookEventName: 'notification', notificationType: 'input_required' }).kind, 'question-request')
assert.equal(t({ hookEventName: 'notification', notificationType: 'agent_error' }).kind, 'session-error')
assert.equal(t({ hookEventName: 'notification', notificationType: 'turn_complete' }).kind, 'turn-completed')
// regression: `ask` is a substring of `task_complete`, so a loose /ask/ in the
// question branch used to steal this one and park the session on `needs-you`
assert.equal(t({ hookEventName: 'notification', notificationType: 'task_complete' }).kind, 'turn-completed')
assert.equal(t({ hookEventName: 'notification', notificationType: 'session_ready' }).kind, 'session-started')
// an unrecognised notification must not invent an activity row
assert.equal(t({ hookEventName: 'notification', notificationType: 'phase_changed' }), null)

// --- negative cases ---------------------------------------------------------

assert.equal(t({ hookEventName: 'UnknownEvent' }), null)
// PascalCase is the config spelling, never the payload spelling
assert.equal(t({ hookEventName: 'SessionStart' }), null)
assert.equal(t(null), null)
assert.equal(t('nope'), null)
assert.equal(t({}), null)

// --- generated hook config --------------------------------------------------

const config = buildGrokHookConfig('/home/u/.grok/hooks/vibby-hook.sh')
const parsed = JSON.parse(config)
assert.equal(Object.keys(parsed.hooks).length, GROK_HOOK_EVENTS.length)
for (const event of GROK_HOOK_EVENTS) {
    const group = parsed.hooks[event]
    assert.equal(group.length, 1)
    assert.equal(group[0].hooks.length, 1)
    assert.equal(group[0].hooks[0].type, 'command')
    assert.equal(group[0].hooks[0].command, '/home/u/.grok/hooks/vibby-hook.sh')
    assert.equal(group[0].hooks[0].timeout, 5)
    // a matcher on Stop/UserPromptSubmit is rejected with a warning, so the
    // groups stay matcher-less across the board
    assert.equal(group[0].matcher, undefined)
}
// no `$` anywhere: the bridge reads its variables from the environment instead
// of relying on grok's unspecified load-time vs run-time expansion
assert.ok(!config.includes('$'))

// --- generated bridge scripts -----------------------------------------------

const sh = buildGrokHookScript()
assert.ok(sh.startsWith('#!/bin/sh\n'))
// guard first: a session Vibby did not launch must exit before reading stdin
assert.ok(sh.indexOf(`[ -n "$${GROK_HOOK_SESSION_ENV}" ] || exit 0`) > 0)
assert.ok(sh.includes(`$${GROK_HOOK_DROP_ENV}/$${GROK_HOOK_SESSION_ENV}.XXXXXX`))
// the rename is what publishes the payload to the poller
assert.ok(sh.includes('mv "$f" "$f.json"'))
assert.ok(sh.includes(`--data-binary @- "$${GROK_HOOK_ENDPOINT_ENV}"`))
// the drop name has to satisfy wslHookBridge's DROP_FILE_RE
assert.match('s1.aB3xY9.json', /^([\w-]{1,64})\.[A-Za-z0-9]{6}\.json$/)

const cmd = buildGrokHookScriptCmd()
assert.ok(cmd.startsWith('@echo off\r\n'))
assert.ok(cmd.includes(`if "%${GROK_HOOK_SESSION_ENV}%"=="" exit /b 0`))
assert.ok(cmd.includes('vibby-hook.ps1'))

const ps1 = buildGrokHookScriptPs1()
assert.ok(ps1.includes(`$env:${GROK_HOOK_SESSION_ENV}`))
assert.ok(ps1.includes('[IO.File]::Move($f, $f + \'.json\')'))
// regression: [Console]::In decodes stdin with the console code page, and grok
// spawns hooks under the system default — a CP936 machine turned a `你好`
// prompt into `浣犲ソ`. The payload must never be decoded on the way through.
assert.ok(!ps1.includes('[Console]::In'))
assert.ok(ps1.includes('[Console]::OpenStandardInput()'))
assert.ok(ps1.includes('[IO.File]::WriteAllBytes($f, $payload)'))
assert.ok(!ps1.includes('WriteAllText'))

// --- environment injection --------------------------------------------------

assert.deepEqual(
    withoutStaleGrokHookEnv({
        PATH: '/usr/bin',
        [GROK_HOOK_SESSION_ENV]: 'old',
        [GROK_HOOK_DROP_ENV]: '/tmp/old',
        [GROK_HOOK_ENDPOINT_ENV]: 'http://127.0.0.1:1/x',
    }),
    { PATH: '/usr/bin' },
)

const dropEnv = grokHookEnvironment('s1', { dropDir: '/mnt/c/tmp/vibby-grok-ab12/drop' }, { PATH: '/usr/bin' })
assert.equal(dropEnv[GROK_HOOK_SESSION_ENV], 's1')
assert.equal(dropEnv[GROK_HOOK_DROP_ENV], '/mnt/c/tmp/vibby-grok-ab12/drop')
assert.equal(dropEnv[GROK_HOOK_ENDPOINT_ENV], undefined)
assert.equal(dropEnv.PATH, '/usr/bin')

// the drop lane wins when both are offered
const bothEnv = grokHookEnvironment('s1', { dropDir: '/d', endpoint: 'http://127.0.0.1:1/x' })
assert.equal(bothEnv[GROK_HOOK_DROP_ENV], '/d')
assert.equal(bothEnv[GROK_HOOK_ENDPOINT_ENV], undefined)

const httpEnv = grokHookEnvironment('s1', { endpoint: 'http://127.0.0.1:5/vibby/t/grok/s1' })
assert.equal(httpEnv[GROK_HOOK_ENDPOINT_ENV], 'http://127.0.0.1:5/vibby/t/grok/s1')
assert.equal(httpEnv[GROK_HOOK_DROP_ENV], undefined)

const wslEnv = grokHookEnvironment('s1', { dropDir: '/d' }, {}, { wsl: true })
assert.match(wslEnv.WSLENV, new RegExp(GROK_HOOK_SESSION_ENV))
assert.match(wslEnv.WSLENV, new RegExp(GROK_HOOK_DROP_ENV))
// the unused lane must not be advertised across the boundary
assert.ok(!new RegExp(GROK_HOOK_ENDPOINT_ENV).test(wslEnv.WSLENV))

// --- recovery ---------------------------------------------------------------

assert.equal(grokHookRecovery({}), null)
assert.equal(grokHookRecovery({ [GROK_HOOK_SESSION_ENV]: 'bad id' }), null)
assert.equal(grokHookRecovery({ [GROK_HOOK_SESSION_ENV]: '../escape' }), null)
assert.deepEqual(
    grokHookRecovery({ [GROK_HOOK_SESSION_ENV]: '019fae27-98f8-7793-997b-98c738a7a969' }),
    { sessionId: '019fae27-98f8-7793-997b-98c738a7a969' },
)

console.log('grokHooks.test.cjs: all assertions passed')
