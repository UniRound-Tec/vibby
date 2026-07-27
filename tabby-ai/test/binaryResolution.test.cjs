const assert = require('node:assert/strict')
const { selectLookupResult } = require('../.test-build/binaryResolution.js')

assert.equal(selectLookupResult(null), null)
assert.equal(selectLookupResult(''), null)
assert.equal(selectLookupResult('\r\nC:\\Tools\\codex.cmd\r\n'), 'C:\\Tools\\codex.cmd')

const packagedCodexResults = [
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\resources\\codex',
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe',
].join('\r\n')

assert.equal(
    selectLookupResult(packagedCodexResults, true),
    null,
    'desktop app internals are not standalone CLIs',
)
assert.equal(
    selectLookupResult(`${packagedCodexResults}\r\nC:\\Users\\Jesse\\AppData\\Roaming\\npm\\codex.cmd`, true),
    'C:\\Users\\Jesse\\AppData\\Roaming\\npm\\codex.cmd',
    'a later standalone CLI remains selectable',
)

console.log('binaryResolution.test.cjs: all assertions passed')
