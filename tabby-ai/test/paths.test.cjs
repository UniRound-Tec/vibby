// Unit tests for the temp-path naming module.
// Run via `yarn test` in tabby-ai/ — see events.test.cjs for the pattern.
const assert = require('node:assert/strict')
const path = require('node:path')
const {
    HOOK_DIR_PREFIX,
    SHIM_DIR_PREFIX,
    isHookDirName,
    isLegacyHookDirName,
    isGeneratedPath,
    holdsOnlyGeneratedFiles,
    quoteCmd,
    quoteSh,
} = require('../.test-build/paths.js')

// --- hook directory names: exactly the shape mkdtemp produces ---
assert.equal(isHookDirName('vibby-hooks-Ab3xY9'), true)
assert.equal(isHookDirName('vibby-hooks-000000'), true)
// cleanupStaleFiles() deletes matches recursively out of a shared /tmp, so
// anything that is not mkdtemp-shaped must not match
assert.equal(isHookDirName('vibby-hooks-notes'), false, 'user directory sharing the prefix')
assert.equal(isHookDirName('vibby-hooks-Ab3xY9/nested'), false)
assert.equal(isHookDirName('vibby-hooks-'), false)
assert.equal(isHookDirName('vibby-hooks'), false, 'the pre-mkdtemp fixed name is matched separately')
assert.equal(isHookDirName('vibby-hooksomething'), false)
assert.equal(isHookDirName('tmp'), false)

// --- the pre-mkdtemp directory still gets collected, exactly and only it ---
assert.equal(isLegacyHookDirName('vibby-hooks'), true)
assert.equal(isLegacyHookDirName('vibby-hooks-Ab3xY9'), false, 'a current directory is not legacy')
assert.equal(isLegacyHookDirName('vibby-hooks-notes'), false)
assert.equal(isLegacyHookDirName('vibby-hooks2'), false)

// --- contents check: the name alone never authorizes the recursive delete ---
assert.equal(holdsOnlyGeneratedFiles([]), true, 'empty directory is ours to drop')
assert.equal(holdsOnlyGeneratedFiles(['123-uuid.json', 'vibby-cli-123-uuid']), true)
assert.equal(holdsOnlyGeneratedFiles(['123-uuid.json', 'important.txt']), false)
assert.equal(holdsOnlyGeneratedFiles(['.ssh']), false)

// --- generated paths, as they appear in a profile's pathPrefix ---
// shim directory under a current (mkdtemp) hook directory
assert.equal(isGeneratedPath(path.join('/tmp', 'vibby-hooks-Ab3xY9', 'vibby-cli-123-uuid')), true)
// ...and one left over in a recovered profile from before mkdtemp landed
assert.equal(isGeneratedPath(path.join('/tmp', 'vibby-hooks', 'vibby-cli-123-uuid')), true)
// the shim prefix alone is enough, wherever it sits
assert.equal(isGeneratedPath(path.join('/somewhere', 'else', 'vibby-cli-9-abc')), true)

// --- paths we must never strip out of a user's PATH ---
assert.equal(isGeneratedPath('/usr/local/bin'), false)
assert.equal(isGeneratedPath(path.join('/home', 'me', '.local', 'bin')), false)
// a user directory that merely shares the prefix
assert.equal(isGeneratedPath(path.join('/home', 'me', 'vibby-hooks-notes', 'bin')), false)

// --- the constants the adapter bakes into filenames ---
assert.equal(HOOK_DIR_PREFIX, 'vibby-hooks')
assert.equal(SHIM_DIR_PREFIX, 'vibby-cli-')
// arm() strips stale `--settings` args by substring-matching this prefix, so a
// real mkdtemp path has to contain it
assert.ok(path.join('/tmp', 'vibby-hooks-Ab3xY9', '1-uuid.json').includes(HOOK_DIR_PREFIX))

// --- shim quoting: these strings end up in a generated .cmd / .sh wrapper ---
assert.equal(quoteCmd('C:\\Program Files\\nodejs\\claude.cmd'), '"C:\\Program Files\\nodejs\\claude.cmd"')
// cmd expands %VAR% while running the batch file, so percent signs must double
assert.equal(quoteCmd('C:\\100%\\claude.cmd'), '"C:\\100%%\\claude.cmd"')
assert.equal(quoteCmd('%USERPROFILE%'), '"%%USERPROFILE%%"', 'must not resolve at run time')
assert.equal(quoteCmd('say "hi"'), '"say ""hi"""')
// a hook settings path is the realistic argument, and it holds no metacharacters
assert.equal(
    quoteCmd('C:\\Temp\\vibby-hooks-Ab3xY9\\1234-uuid.json'),
    '"C:\\Temp\\vibby-hooks-Ab3xY9\\1234-uuid.json"',
)

assert.equal(quoteSh('/usr/local/bin/claude'), "'/usr/local/bin/claude'")
assert.equal(quoteSh("it's"), "'it'\\''s'", 'single quotes close and reopen')
// the sh wrapper is not a batch file, so percent is an ordinary character
assert.equal(quoteSh('/tmp/100%/claude'), "'/tmp/100%/claude'")
// nothing a shell would act on survives the quoting
for (const hostile of ['$(whoami)', '`id`', 'a; rm -rf /', 'a && b', '$HOME']) {
    const quoted = quoteSh(hostile)
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), hostile)
    assert.ok(!quoted.slice(1, -1).includes("'"), `${hostile} must not break out of the quotes`)
}

console.log('paths.test.cjs: all assertions passed')
