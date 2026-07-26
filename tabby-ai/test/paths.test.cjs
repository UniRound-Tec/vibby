// Unit tests for the temp-path naming module.
// Run via `yarn test` in tabby-ai/ — see events.test.cjs for the pattern.
const assert = require('node:assert/strict')
const path = require('node:path')
const {
    HOOK_DIR_PREFIX,
    SHIM_DIR_PREFIX,
    isHookDirName,
    isGeneratedPath,
    holdsOnlyGeneratedFiles,
} = require('../.test-build/paths.js')

// --- hook directory names: exactly the shape mkdtemp produces ---
assert.equal(isHookDirName('vibby-hooks-Ab3xY9'), true)
assert.equal(isHookDirName('vibby-hooks-000000'), true)
// cleanupStaleFiles() deletes matches recursively out of a shared /tmp, so
// anything that is not mkdtemp-shaped must not match
assert.equal(isHookDirName('vibby-hooks-notes'), false, 'user directory sharing the prefix')
assert.equal(isHookDirName('vibby-hooks-Ab3xY9/nested'), false)
assert.equal(isHookDirName('vibby-hooks-'), false)
assert.equal(isHookDirName('vibby-hooks'), false, 'the pre-mkdtemp fixed name is not ours to delete')
assert.equal(isHookDirName('vibby-hooksomething'), false)
assert.equal(isHookDirName('tmp'), false)

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

console.log('paths.test.cjs: all assertions passed')
