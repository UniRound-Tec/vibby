const assert = require('node:assert/strict')
const {
    mergeWindowsPath,
    parseWindowsRegistryPath,
    selectLookupResult,
} = require('../.test-build/binaryResolution.js')

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
assert.equal(
    selectLookupResult([
        'C:\\Users\\Jesse\\AppData\\Roaming\\npm\\gemini',
        'C:\\Users\\Jesse\\AppData\\Roaming\\npm\\gemini.cmd',
    ].join('\r\n'), true),
    'C:\\Users\\Jesse\\AppData\\Roaming\\npm\\gemini.cmd',
    'Windows npm command shims take precedence over extensionless shell scripts',
)

const registryOutput = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin;C:\\Tools',
].join('\r\n')
assert.equal(
    parseWindowsRegistryPath(registryOutput, { LOCALAPPDATA: 'C:\\Users\\Jesse\\AppData\\Local' }),
    'C:\\Users\\Jesse\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin;C:\\Tools',
)
assert.equal(parseWindowsRegistryPath('ERROR: missing', {}), null)
assert.equal(
    mergeWindowsPath(
        'C:\\Existing;C:\\Shared\\;C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources',
        'C:\\New;C:\\Shared',
    ),
    'C:\\New;C:\\Shared;C:\\Existing;C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources',
    'fresh user entries take precedence and duplicates are removed',
)
assert.equal(mergeWindowsPath(undefined, 'C:\\New'), 'C:\\New')
assert.equal(mergeWindowsPath(undefined, null), null)

console.log('binaryResolution.test.cjs: all assertions passed')
