const assert = require('node:assert/strict')
const {
    DROP_FILE_LIMIT,
    dropFileSessionId,
    sortDropFiles,
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

// --- ordering ---
const sorted = sortDropFiles([
    { name: 'b.222222.json', mtimeMs: 200 },
    { name: 'z.111111.json', mtimeMs: 100 },
    { name: 'a.333333.json', mtimeMs: 200 },
])
assert.deepEqual(sorted.map(f => f.name), ['z.111111.json', 'a.333333.json', 'b.222222.json'])

assert.equal(DROP_FILE_LIMIT, 1024 * 1024, 'file lane matches the HTTP body limit')

console.log('wslHookBridge.test.cjs: all assertions passed')
