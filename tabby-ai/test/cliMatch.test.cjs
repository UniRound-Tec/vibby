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
    { id: 'pi', binaries: ['pi'], runtimeMarkers: ['@earendil-works/pi-coding-agent'] },
    { id: 'github-copilot', binaries: ['copilot'], runtimeMarkers: ['@github/copilot', 'github/copilot-cli'] },
    { id: 'antigravity-cli', binaries: ['agy'], runtimeMarkers: ['antigravity-cli'] },
    { id: 'cursor-agent', binaries: ['cursor-agent'], runtimeMarkers: ['cursor-agent'] },
    { id: 'cline', binaries: ['cline'], runtimeMarkers: ['/node_modules/cline/', '@cline/cli'] },
    { id: 'qwen-code', binaries: ['qwen'], runtimeMarkers: ['@qwen-code/qwen-code'] },
    { id: 'kimi-code', binaries: ['kimi'], runtimeMarkers: ['@moonshot-ai/kimi-code', 'moonshotai/kimi-code'] },
    { id: 'grok-build', binaries: ['grok'], runtimeMarkers: ['@xai-official/grok', 'xai-org/grok-build'] },
    { id: 'kiro-cli', binaries: ['kiro-cli'], runtimeMarkers: ['kiro-cli'] },
    { id: 'kilo-code', binaries: ['kilo'], runtimeMarkers: ['@kilocode/cli'] },
    { id: 'crush', binaries: ['crush'], runtimeMarkers: ['@charmland/crush', 'charmbracelet/crush'] },
    { id: 'factory-droid', binaries: ['droid'], runtimeMarkers: ['/node_modules/droid/', '@factory-ai/droid'] },
    { id: 'devin-cli', binaries: ['devin'], runtimeMarkers: ['devin-cli'] },
    { id: 'amp', binaries: ['amp'], runtimeMarkers: ['@ampcode/cli', 'ampcode'] },
]
const match = (...procs) => matchCli(procs, REGISTRY)
const proc = (command, commandLine) => ({ command, commandLine })

// --- ① the process is the binary ---
assert.equal(match(proc('claude')), 'claude-code')
assert.equal(match(proc('claude.cmd')), 'claude-code')
assert.equal(match(proc('C:\\Users\\me\\AppData\\npm\\claude.exe')), 'claude-code')
assert.equal(match(proc('pi')), 'pi')
for (const [binary, id] of [
    ['copilot', 'github-copilot'],
    ['agy', 'antigravity-cli'],
    ['cursor-agent', 'cursor-agent'],
    ['cline', 'cline'],
    ['qwen', 'qwen-code'],
    ['kimi', 'kimi-code'],
    ['grok', 'grok-build'],
    ['kiro-cli', 'kiro-cli'],
    ['kilo', 'kilo-code'],
    ['crush', 'crush'],
    ['droid', 'factory-droid'],
    ['devin', 'devin-cli'],
    ['amp', 'amp'],
]) {
    assert.equal(match(proc(binary)), id, binary)
    assert.equal(match(proc(`${binary}.cmd`)), id, `${binary}.cmd`)
}

// --- ② package marker in the command line (npm entry points) ---
assert.equal(
    match(proc('node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')),
    'claude-code',
)
assert.equal(
    match(proc('node.exe', 'node.exe "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"')),
    'codex',
)
// runtime flags before the script are skipped, the script argument still counts
assert.equal(
    match(proc('node', 'node --max-old-space-size=4096 /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')),
    'claude-code',
)

// --- ③ an argument that is itself an invocation ---
assert.equal(match(proc('node', 'node /home/me/bin/claude.js')), 'claude-code')
assert.equal(match(proc('sh', 'sh /usr/local/bin/cline')), 'cline')
assert.equal(match(proc('python', 'python ./tools/pi.py')), 'pi')

// --- the false positives this all exists to prevent ---
// a marker mentioned as data is not a marker in an executed position
assert.equal(match(proc('rg', 'rg @openai/codex docs')), null, 'rg @openai/codex')
assert.equal(match(proc('bash', 'bash -c "grep @openai/codex file"')), null, 'marker inside a shell -c string')
assert.equal(
    match(proc('node', 'node server.js --plugin=@openai/codex-helper')),
    null,
    'marker inside a flag of an unrelated script',
)
// ...and a data argument after the script is not an executed position either
assert.equal(
    match(proc('node', 'node server.js --plugin @openai/codex-helper')),
    null,
    'marker as a flag value of an unrelated script',
)
// a bare word that happens to be a binary name is not evidence of anything
assert.equal(match(proc('grep', 'grep claude notes.md')), null, 'grep claude')
assert.equal(match(proc('bash', 'cd claude')), null, 'cd claude')
assert.equal(match(proc('git', 'git commit -m claude')), null, 'git commit -m claude')
assert.equal(match(proc('python', 'python train.py --model pi')), null, '--model pi')
assert.equal(match(proc('node', 'node server.js --name codex')), null, '--name codex')
assert.equal(match(proc('python', 'python train.py --name amp')), null, '--name amp')
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
