const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildPosixCliShim, buildWindowsCliShim } = require('../.test-build/terminalCliShim.js')

const detected = {
    entry: { binaries: ['opencode'] },
    command: 'C:\\Program Files\\OpenCode\\opencode.cmd',
    launcher: 'cmd',
    version: '1.17.9',
}
const args = ['--hostname', '127.0.0.1', '--port', '43210']
const env = { VIBBY_OPENCODE_MONITOR: '1', VALUE_WITH_PERCENT: '10%' }
const passthrough = ['attach', 'auth', 'session']

const windows = buildWindowsCliShim(detected, args, env, passthrough)
assert.match(windows, /if \/I "%~1"=="attach" goto vibby_passthrough/)
assert.match(windows, /set "VIBBY_OPENCODE_MONITOR=1"/)
assert.match(windows, /set "VALUE_WITH_PERCENT=10%%"/)
assert.match(windows, /call "C:\\Program Files\\OpenCode\\opencode\.cmd" "--hostname" "127\.0\.0\.1" "--port" "43210" %\*/)
assert.match(windows, /:vibby_passthrough\r\ncall "C:\\Program Files\\OpenCode\\opencode\.cmd" %\*/)

const posixDetected = { ...detected, command: "/opt/open code/opencode's", launcher: 'sh' }
const posix = buildPosixCliShim(posixDetected, args, { VIBBY: "it's safe" }, passthrough)
assert.match(posix, /case "\$\{1-\}" in/)
assert.match(posix, /attach\|auth\|session\) exec/)
assert.match(posix, /VIBBY='it'\\''s safe'/)
assert.match(posix, /exec VIBBY=.*'\/opt\/open code\/opencode'\\''s' '--hostname'/)

assert.throws(
    () => buildWindowsCliShim(detected, args, {}, ['attach & whoami']),
    /unsafe shim passthrough/,
)
assert.throws(
    () => buildWindowsCliShim(detected, args, { 'BAD&KEY': 'value' }, []),
    /unsafe shim environment/,
)

if (process.platform === 'win32') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibby-shim-test-'))
    try {
        const target = path.join(directory, 'target.cmd')
        const wrapper = path.join(directory, 'opencode.cmd')
        fs.writeFileSync(target, '@echo off\r\necho MONITOR=%VIBBY_OPENCODE_MONITOR%\r\necho ARGS=%*\r\n')
        fs.writeFileSync(wrapper, buildWindowsCliShim(
            { ...detected, command: target },
            args,
            { VIBBY_OPENCODE_MONITOR: '1' },
            ['attach'],
        ))

        const monitored = spawnSync('cmd.exe', ['/d', '/c', wrapper, 'run', 'hello world'], { encoding: 'utf8' })
        assert.equal(monitored.status, 0)
        assert.match(monitored.stdout, /MONITOR=1/)
        assert.match(monitored.stdout, /ARGS="--hostname" "127\.0\.0\.1" "--port" "43210" run "hello world"/)

        const passthroughResult = spawnSync('cmd.exe', ['/d', '/c', wrapper, 'attach', 'http://localhost'], { encoding: 'utf8' })
        assert.equal(passthroughResult.status, 0)
        assert.match(passthroughResult.stdout, /MONITOR=\r?\n/)
        assert.match(passthroughResult.stdout, /ARGS=attach http:\/\/localhost/)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

console.log('terminalCliShim.test.cjs: all assertions passed')
