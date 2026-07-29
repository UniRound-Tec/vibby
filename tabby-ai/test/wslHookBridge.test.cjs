const assert = require('node:assert/strict')
const {
    DROP_FILE_LIMIT,
    dropFileSessionId,
    selectWslHookTransport,
    sortDropFiles,
    windowsDropHookCommand,
    wslDropHookCommand,
} = require('../.test-build/wslHookBridge.js')

const SESSION = 'f3b1a5c2-9d4e-4a7b-8c6d-0e1f2a3b4c5d'

// --- the command claude runs inside the distro ---
const command = wslDropHookCommand('/mnt/c/Users/dev/AppData/Local/Temp/vibby-hooks-Ab12Cd/drop', SESSION)
assert.equal(
    command,
    `f=$(mktemp '/mnt/c/Users/dev/AppData/Local/Temp/vibby-hooks-Ab12Cd/drop/${SESSION}.XXXXXX') && cat > "$f" && mv "$f" "$f.json"`,
)

// A username can put a quote into the temp path; it must not escape the
// single-quoted mktemp template.
assert.equal(
    wslDropHookCommand(`/mnt/c/Users/o'brien/drop`, SESSION).includes(`'/mnt/c/Users/o'\\''brien/drop/`),
    true,
)

const windowsCommand = windowsDropHookCommand(
    `C:\\Users\\o'brien\\AppData\\Local\\Temp\\vibby-hooks-Ab12Cd\\drop`,
    SESSION,
)
assert.ok(windowsCommand.startsWith('powershell.exe -NoLogo -NoProfile -NonInteractive'))
assert.ok(windowsCommand.includes(`$s='${SESSION}'`))
assert.ok(windowsCommand.includes(`C:\\Users\\o''brien\\AppData`), 'PowerShell quote is escaped')
assert.ok(windowsCommand.includes('[IO.File]::Move'), 'final rename makes the file atomic')
// regression: [Console]::In decodes stdin with the console code page, and CLIs
// spawn hooks under the system default — a CP936 machine turned a `你好` prompt
// into `浣犲ソ`. The payload must cross as raw bytes.
assert.ok(!windowsCommand.includes('[Console]::In.'), 'stdin is never decoded')
assert.ok(windowsCommand.includes('[IO.File]::WriteAllBytes'), 'payload is written as bytes')

// --- drop file names ---
// mktemp fills XXXXXX with [A-Za-z0-9]; the poller must take exactly what the
// command writes and nothing else.
assert.equal(dropFileSessionId(`${SESSION}.aB3xY9.json`), SESSION)
assert.equal(dropFileSessionId(`${SESSION}.aB3xY9`), null, 'in-flight file, not yet renamed')
assert.equal(dropFileSessionId(`${SESSION}.aB3.json`), null, 'nonce too short')
assert.equal(dropFileSessionId(`${SESSION}.aB3xY9.json.json`), null, 'double extension')
assert.equal(dropFileSessionId('.aB3xY9.json'), null, 'empty session')
assert.equal(dropFileSessionId(`${'x'.repeat(65)}.aB3xY9.json`), null, 'session id too long')
assert.equal(dropFileSessionId('desktop.ini'), null)

// WSL binfmt interop can be true during distro cold-start and disappear once
// systemd-binfmt settles. The durable /mnt/c file lane must win whenever both
// transports appear available.
assert.equal(
    selectWslHookTransport({
        dropAvailable: true,
        curlAvailable: true,
        interop: true,
    }),
    'file',
)
assert.equal(
    selectWslHookTransport({
        dropAvailable: false,
        curlAvailable: true,
        interop: true,
    }),
    'curl',
)

// --- ordering ---
const sorted = sortDropFiles([
    { name: 'b.222222.json', mtimeMs: 200 },
    { name: 'z.111111.json', mtimeMs: 100 },
    { name: 'a.333333.json', mtimeMs: 200 },
])
assert.deepEqual(sorted.map(f => f.name), ['z.111111.json', 'a.333333.json', 'b.222222.json'])

assert.equal(DROP_FILE_LIMIT, 1024 * 1024, 'file lane matches the HTTP body limit')

console.log('wslHookBridge.test.cjs: all assertions passed')
