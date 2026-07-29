// Unit tests for Pi hook payload translation and extension generation.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const {
    PI_HOOK_ENDPOINT_ENV,
    PI_HOOK_DROP_DIR_ENV,
    PI_HOOK_LOG_ENV,
    PI_HOOK_ROUTE_FILE_NAME,
    PI_HOOK_SESSION_ENV,
    buildPiExtensionSource,
    injectPiExtensionArgs,
    piHookRecovery,
    piWslDistroFromArgs,
    piHookEnvironment,
    translatePiHook,
    withoutStalePiHookArgs,
} = require('../.test-build/piHooks.js')

// Restored WSL tabs may have no targetId, so the wrapper itself must identify
// the distro before any extension path is injected.
assert.equal(
    piWslDistroFromArgs([
        '--distribution', 'Ubuntu-22.04',
        '--cd', '~',
        '--exec', '/home/jesse/.local/bin/pi',
    ]),
    'Ubuntu-22.04',
)
assert.equal(piWslDistroFromArgs(['--distribution', 'Ubuntu-22.04']), null)
assert.equal(piWslDistroFromArgs(['/c', 'pi.cmd']), null)

// Every supported launcher must receive -e after its own executable.
const extensionPath = 'C:\\Temp\\vibby-pi-abc123\\vibby-extension.ts'
assert.deepEqual(
    injectPiExtensionArgs(['--model', 'test'], '/tmp/vibby-extension.ts'),
    ['-e', '/tmp/vibby-extension.ts', '--model', 'test'],
    'macOS/Linux direct launch',
)

assert.deepEqual(
    piHookRecovery(
        ['/c', 'pi.cmd', '-e', 'C:\\Temp\\vibby-pi-abc123\\vibby-extension.ts'],
        {
            [PI_HOOK_DROP_DIR_ENV]: 'C:\\Temp\\vibby-pi-abc123',
            [PI_HOOK_SESSION_ENV]: 'session-1',
        },
    ),
    {
        sessionId: 'session-1',
        dropDir: 'C:\\Temp\\vibby-pi-abc123',
        tempName: 'vibby-pi-abc123',
    },
)
assert.deepEqual(
    piHookRecovery(
        [
            '--distribution', 'Ubuntu', '--cd', '~', '--exec', '/usr/bin/pi',
            '-e', '/mnt/c/Temp/vibby-pi-wsl123/vibby-extension.ts',
        ],
        {
            [PI_HOOK_DROP_DIR_ENV]: '/mnt/c/Temp/vibby-pi-wsl123',
            [PI_HOOK_SESSION_ENV]: 'session-wsl',
        },
    ),
    {
        sessionId: 'session-wsl',
        dropDir: '/mnt/c/Temp/vibby-pi-wsl123',
        tempName: 'vibby-pi-wsl123',
    },
)
assert.equal(
    piHookRecovery(
        ['-e', 'C:\\Temp\\vibby-pi-one\\vibby-extension.ts'],
        {
            [PI_HOOK_DROP_DIR_ENV]: 'C:\\Temp\\vibby-pi-other',
            [PI_HOOK_SESSION_ENV]: 'session-1',
        },
    ),
    null,
    'extension and drop route must refer to the same generated temp root',
)
assert.deepEqual(
    injectPiExtensionArgs(['/c', 'C:\\npm\\pi.cmd', '--model', 'test'], extensionPath),
    ['/c', 'C:\\npm\\pi.cmd', '-e', extensionPath, '--model', 'test'],
    'Windows cmd shim',
)
assert.deepEqual(
    injectPiExtensionArgs(
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\npm\\pi.ps1', '--model', 'test'],
        extensionPath,
    ),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\npm\\pi.ps1', '-e', extensionPath, '--model', 'test'],
    'Windows PowerShell shim',
)
assert.deepEqual(
    injectPiExtensionArgs(
        ['--distribution', 'Ubuntu', '--cd', '~', '--exec', '/usr/bin/pi', '--model', 'test'],
        '/mnt/c/Temp/vibby-extension.ts',
    ),
    ['--distribution', 'Ubuntu', '--cd', '~', '--exec', '/usr/bin/pi', '-e', '/mnt/c/Temp/vibby-extension.ts', '--model', 'test'],
    'WSL wrapper',
)
assert.deepEqual(
    injectPiExtensionArgs(
        [
            '--distribution', 'Ubuntu',
            '--cd', '~',
            '--exec',
            '/usr/bin/env',
            'PATH=/home/jesse/.nvm/versions/node/v22.22.3/bin:/usr/bin',
            '/home/jesse/.nvm/versions/node/v22.22.3/bin/pi',
            '--model', 'test',
        ],
        '/mnt/c/Temp/vibby-extension.ts',
    ),
    [
        '--distribution', 'Ubuntu',
        '--cd', '~',
        '--exec',
        '/usr/bin/env',
        'PATH=/home/jesse/.nvm/versions/node/v22.22.3/bin:/usr/bin',
        '/home/jesse/.nvm/versions/node/v22.22.3/bin/pi',
        '-e', '/mnt/c/Temp/vibby-extension.ts',
        '--model', 'test',
    ],
    'WSL env PATH wrapper',
)

// Hot restoration removes Vibby's dead temp extension without touching user extensions.
assert.deepEqual(
    withoutStalePiHookArgs([
        '-e', '/home/jesse/my-extension.ts',
        '--extension=C:\\Temp\\vibby-pi-abc123\\vibby-extension.ts',
        '--extension', '/tmp/vibby-pi-def456/vibby-extension.ts',
        '--model', 'test',
    ]),
    ['-e', '/home/jesse/my-extension.ts', '--model', 'test'],
)
assert.deepEqual(
    withoutStalePiHookArgs([
        '-e',
        '/home/jesse/C:\\Users\\Jesse\\AppData\\Local\\Temp\\vibby-pi-gBZr8A\\vibby-extension.ts',
    ]),
    [],
    'mixed WSL/Windows stale paths are removed before the PTY can spawn',
)

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

const loggedWslEnv = piHookEnvironment(
    'http://127.0.0.1:1/vibby/abc/pi/s1',
    '/tmp/drop',
    's1',
    {},
    '/tmp/drop/vibby-pi-extension.log',
)
assert.equal(loggedWslEnv[PI_HOOK_LOG_ENV], '/tmp/drop/vibby-pi-extension.log')
assert.match(loggedWslEnv.WSLENV, new RegExp(`(^|:)${PI_HOOK_LOG_ENV}(:|$)`))

// --- generated extension source ---
const extension = buildPiExtensionSource()
assert.match(extension, /export default function/)
assert.match(extension, /pi\.on\("session_start"/)
assert.match(extension, /pi\.on\("input"/)
assert.match(extension, /pi\.on\("agent_start"/)
assert.match(extension, /pi\.on\("message_update"/)
assert.match(extension, /thinking_start/)
assert.match(extension, /thinking_delta/)
assert.match(extension, /sendEvent\(\{ type: "thinking" \}\)/)
assert.match(extension, /pi\.on\("tool_call"/)
assert.match(extension, /pi\.on\("tool_result"/)
assert.match(extension, /pi\.on\("turn_end"/)
assert.match(extension, /pi\.on\("agent_settled"/)
assert.match(extension, /runErrored \? "agent_error" : "agent_settled"/)
assert.doesNotMatch(extension, /pi\.on\("agent_end"/)
assert.match(extension, new RegExp(`process\.env\.${PI_HOOK_ENDPOINT_ENV}`))
assert.match(extension, new RegExp(`process\.env\.${PI_HOOK_DROP_DIR_ENV}`))
assert.match(extension, new RegExp(`process\.env\.${PI_HOOK_SESSION_ENV}`))
assert.match(extension, new RegExp(PI_HOOK_ROUTE_FILE_NAME))
assert.match(extension, /readFileSync\(ROUTE_PATH/)
assert.match(extension, /writeFileSync/)
assert.match(extension, /renameSync/)
assert.match(extension, /appendFileSync/)
assert.match(extension, /slice\(2, 8\)\.padEnd\(6, "0"\)/, 'Pi drop files must use the poller nonce contract')
assert.match(extension, /\.json/)
assert.match(extension, /VIBBY_PI_LOG_PATH/)
assert.match(extension, /MAX_EVENT_BYTES/)
assert.match(extension, /response => response\.resume\(\)/)
assert.match(extension, /req\.setTimeout\(3000/)
assert.match(extension, /return \{ action: "continue" \}/, 'input hook must let Pi continue processing')
assert.doesNotMatch(extension, /console\.log|console\.error/, 'extension must not pollute Pi terminal with logs')
assert.doesNotMatch(extension, /127\.0\.0\.1|session-[0-9]/, 'endpoint must come from env, not baked into source')

// Execute the generated extension over its WSL file-drop transport. Large raw
// tool payloads must never cross the boundary or interfere with Pi callbacks.
const dropDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibby-pi-hook-test-'))
const savedEnv = {
    endpoint: process.env[PI_HOOK_ENDPOINT_ENV],
    drop: process.env[PI_HOOK_DROP_DIR_ENV],
    session: process.env[PI_HOOK_SESSION_ENV],
    log: process.env[PI_HOOK_LOG_ENV],
}
try {
    delete process.env[PI_HOOK_ENDPOINT_ENV]
    process.env[PI_HOOK_DROP_DIR_ENV] = dropDir
    process.env[PI_HOOK_SESSION_ENV] = 'runtime-test'
    process.env[PI_HOOK_LOG_ENV] = path.join(dropDir, 'extension.log')

    const output = ts.transpileModule(extension, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText
    const modulePath = path.join(dropDir, 'extension.cjs')
    const loaded = new Module(modulePath, module)
    loaded.filename = modulePath
    loaded.paths = module.paths
    loaded._compile(output, loaded.filename)

    const handlers = new Map()
    ;(loaded.exports.default ?? loaded.exports)({
        on: (name, handler) => handlers.set(name, handler),
    })
    assert.deepEqual(
        handlers.get('input')({ text: 'x'.repeat(5000), source: 'interactive' }),
        { action: 'continue' },
    )
    handlers.get('tool_call')({
        toolName: 'bash',
        input: { command: 'npm test --token super-secret', content: 'z'.repeat(2_000_000) },
        details: 'z'.repeat(2_000_000),
    })
    handlers.get('tool_result')({
        toolName: 'read',
        input: { path: '/home/jesse/private.txt' },
        content: 'super-secret'.repeat(200_000),
    })
    handlers.get('agent_settled')({})
    handlers.get('agent_start')({})
    handlers.get('message_update')({ assistantMessageEvent: { type: 'error' } })
    handlers.get('agent_settled')({})

    const payloads = fs.readdirSync(dropDir)
        .filter(name => name.endsWith('.json'))
        .map(name => {
            const body = fs.readFileSync(path.join(dropDir, name), 'utf8')
            assert.ok(Buffer.byteLength(body) < 64 * 1024)
            assert.doesNotMatch(body, /super-secret/)
            return JSON.parse(body)
        })
    assert.equal(payloads.find(value => value.type === 'input').event.text.length, 512)
    assert.equal(payloads.find(value => value.type === 'tool_call').event.commandName, 'npm')
    assert.equal(payloads.find(value => value.type === 'tool_result').event.fileName, 'private.txt')
    assert.ok(payloads.some(value => value.type === 'agent_settled'))
    assert.ok(payloads.some(value => value.type === 'agent_error'))
} finally {
    for (const [key, value] of [
        [PI_HOOK_ENDPOINT_ENV, savedEnv.endpoint],
        [PI_HOOK_DROP_DIR_ENV, savedEnv.drop],
        [PI_HOOK_SESSION_ENV, savedEnv.session],
        [PI_HOOK_LOG_ENV, savedEnv.log],
    ]) {
        if (value === undefined) {
            delete process.env[key]
        } else {
            process.env[key] = value
        }
    }
    fs.rmSync(dropDir, { recursive: true, force: true })
}

// --- hook event mapping ---
const t = (payload) => translatePiHook('s1', payload, 42)

let e = t({ type: 'session_start', reason: 'new' })
assert.equal(e.kind, 'session-started')
assert.equal(e.confidence, 'high')
assert.equal(e.sessionId, 's1')
assert.equal(e.ts, 42)
assert.equal(e.raw, undefined, 'raw hook payloads must not be retained')
assert.equal(e.summary, 'ready')

e = t({ type: 'input', event: { text: 'fix the bug', source: 'interactive' } })
assert.equal(e.kind, 'prompt-submitted')
assert.equal(e.summary, 'user: fix the bug')
assert.equal(e.raw, undefined)
// extension-injected input should not be reported as a user prompt
assert.equal(t({ type: 'input', event: { text: 'fix the bug', source: 'extension' } }), null)
// a payload with no text must not render the string "undefined"
assert.equal(t({ type: 'input', event: { source: 'interactive' } }).summary, 'user: ')

e = t({ type: 'thinking' })
assert.equal(e.kind, 'thinking')
assert.equal(e.summary, 'thinking')
assert.equal(e.raw, undefined, 'reasoning text must not be retained')

e = t({ type: 'responding' })
assert.equal(e.kind, 'responding')
assert.equal(e.summary, 'responding')

e = t({ type: 'retrying' })
assert.equal(e.kind, 'retrying')

e = t({ type: 'agent_error' })
assert.equal(e.kind, 'session-error')
assert.equal(e.summary, 'Pi request failed')

e = t({ type: 'tool_call', event: { toolName: 'bash', commandName: 'npm' } })
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'command: npm')

e = t({ type: 'tool_call', event: { toolName: 'edit', fileName: 'auth.ts' } })
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'edit: auth.ts')

e = t({ type: 'tool_call', event: { toolName: 'read', fileName: 'notes.md' } })
assert.equal(e.kind, 'tool-call')
assert.equal(e.summary, 'read: notes.md')

e = t({ type: 'tool_result', event: { toolName: 'bash', isError: false } })
assert.equal(e.kind, 'tool-result')
assert.equal(e.summary, 'tool: bash')

e = t({ type: 'agent_settled' })
assert.equal(e.kind, 'turn-completed')
assert.equal(e.summary, 'done')

assert.equal(t({ type: 'turn_end' }), null)
assert.equal(t({ type: 'agent_end' }), null)

e = t({ type: 'session_shutdown' })
assert.equal(e.kind, 'session-ended')

// --- events we do not subscribe to / garbage → null ---
assert.equal(t({ type: 'unknown' }), null)
assert.equal(t({}), null)
assert.equal(t('not an object'), null)
assert.equal(t(null), null)

console.log('piHooks.test.cjs: all assertions passed')
