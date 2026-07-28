const assert = require('node:assert/strict')
const {
    CLAUDE_ENV_MARKERS,
    claudeEnvironmentOverrides,
} = require('../.test-build/claudeEnvironment.js')

const inheritedFromAgentHost = {
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    COLORTERM: '',
    CLAUDECODE: '1',
}
const child = { ...inheritedFromAgentHost, ...claudeEnvironmentOverrides() }

for (const key of CLAUDE_ENV_MARKERS) {
    assert.equal(child[key], '', `${key} must not leak into child Claude`)
}
assert.equal(child.NO_COLOR, '', 'child Claude must be allowed to emit color')
assert.equal(child.FORCE_COLOR, '', 'inherited FORCE_COLOR=0 must not suppress color')

// PTY session setup owns capability variables and upgrades these separately.
assert.equal(child.TERM, 'dumb')
assert.equal(child.COLORTERM, '')

console.log('claudeEnvironment.test.cjs: all assertions passed')
