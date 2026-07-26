// Regression tests for runtime CLI detection.
// Run via `yarn test` in tabby-ai/ — see events.test.cjs for the pattern.
//
// A false positive here is not cosmetic: the pane gets dragged to the top of
// the rail and given a session card, so the ordinary-shell cases below matter
// as much as the detection ones.
const assert = require('node:assert/strict')
const { matchCli, executableName, looksInvoked } = require('../.test-build/cliMatch.js')

// the shape of the real registry, without pulling in the SVG requires
const REGISTRY = [
    { id: 'claude-code', binaries: ['claude'], runtimeMarkers: ['@anthropic-ai/claude-code'] },
    { id: 'codex', binaries: ['codex'], runtimeMarkers: ['@openai/codex'] },
    { id: 'aider', binaries: ['aider'], runtimeMarkers: ['aider_chat', 'aider-chat'] },
    { id: 'pi', binaries: ['pi'] },
]
const match = (...procs) => matchCli(procs, REGISTRY)
const proc = (command, commandLine) => ({ command, commandLine })

// --- ① the process is the binary ---
assert.equal(match(proc('claude')), 'claude-code')
assert.equal(match(proc('claude.cmd')), 'claude-code')
assert.equal(match(proc('C:\\Users\\me\\AppData\\npm\\claude.exe')), 'claude-code')
assert.equal(match(proc('aider')), 'aider')
assert.equal(match(proc('pi')), 'pi')

// --- ② package marker in the command line (npm entry points) ---
assert.equal(
    match(proc('node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')),
    'claude-code',
)
assert.equal(
    match(proc('node.exe', 'node.exe "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"')),
    'codex',
)
assert.equal(match(proc('python', 'python -m aider_chat --model gpt-4')), 'aider')

// --- ③ an argument that is itself an invocation ---
assert.equal(match(proc('node', 'node /home/me/bin/claude.js')), 'claude-code')
assert.equal(match(proc('sh', 'sh /usr/local/bin/aider')), 'aider')
assert.equal(match(proc('python', 'python ./tools/pi.py')), 'pi')

// a pipx venv puts the marker in argv[0] — the interpreter path itself
assert.equal(
    match(proc('python', '/home/me/.local/pipx/venvs/aider-chat/bin/python /home/me/.local/bin/aider')),
    'aider',
)

// --- the false positives this all exists to prevent ---
// a marker mentioned as data is not a marker in an executed position
assert.equal(match(proc('grep', 'grep aider-chat README.md')), null, 'grep aider-chat')
assert.equal(match(proc('rg', 'rg @openai/codex docs')), null, 'rg @openai/codex')
assert.equal(match(proc('bash', 'bash -c "grep aider-chat file"')), null, 'marker inside a shell -c string')
assert.equal(
    match(proc('node', 'node server.js --plugin=@openai/codex-helper')),
    null,
    'marker inside a flag of an unrelated script',
)
// a bare word that happens to be a binary name is not evidence of anything
assert.equal(match(proc('grep', 'grep claude notes.md')), null, 'grep claude')
assert.equal(match(proc('bash', 'cd claude')), null, 'cd claude')
assert.equal(match(proc('git', 'git commit -m claude')), null, 'git commit -m claude')
assert.equal(match(proc('python', 'python train.py --model pi')), null, '--model pi')
assert.equal(match(proc('node', 'node server.js --name codex')), null, '--name codex')
assert.equal(match(proc('less', 'less aider')), null, 'less aider')
// ...and neither is an ordinary shell with nothing running in it
assert.equal(match(proc('bash', 'bash')), null)
assert.equal(match(), null, 'no child processes')

// --- helpers ---
assert.equal(executableName('/usr/local/bin/claude'), 'claude')
assert.equal(executableName('C:\\tools\\pi.py'), 'pi')
assert.equal(executableName('claude'), 'claude')
// .md is not an executable suffix, so the name keeps it and cannot collide
assert.equal(executableName('claude.md'), 'claude.md')

assert.equal(looksInvoked('claude'), false, 'bare word')
assert.equal(looksInvoked('pi'), false, 'bare word')
assert.equal(looksInvoked('./pi.py'), true, 'path')
assert.equal(looksInvoked('claude.cmd'), true, 'executable extension')
assert.equal(looksInvoked('/usr/bin/claude'), true, 'absolute path')
assert.equal(looksInvoked('C:\\bin\\claude'), true, 'windows path')
assert.equal(looksInvoked('~/bin/claude'), true, 'home-relative path')
assert.equal(looksInvoked('@openai/codex'), false, 'a package name is not a path')
assert.equal(looksInvoked('docs/codex'), false, 'an unrooted word pair is not an invocation')

// --- registry order decides ties ---
assert.equal(
    match(proc('node', 'node /x/@anthropic-ai/claude-code/cli.js'), proc('codex')),
    'claude-code',
    'first registry entry with a match wins',
)

console.log('cliMatch.test.cjs: all assertions passed')
