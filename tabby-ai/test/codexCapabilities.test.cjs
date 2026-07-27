const assert = require('node:assert/strict')
const { supportsCodexHooks } = require('../.test-build/codexCapabilities.js')

assert.equal(supportsCodexHooks('hooks                    stable       true'), true)
assert.equal(supportsCodexHooks('hooks                    stable       false'), false)
assert.equal(supportsCodexHooks('hooks                    experimental true'), false)
assert.equal(supportsCodexHooks(null), false)

console.log('codexCapabilities.test.cjs: all assertions passed')
