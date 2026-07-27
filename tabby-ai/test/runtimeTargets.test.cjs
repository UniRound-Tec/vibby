const assert = require('node:assert/strict')
const {
    decodeWslOutput,
    isWindowsMountedWslPath,
    mergeWslTargets,
    nativeRuntimeTarget,
    parseWslNames,
    preferredRuntimeTarget,
    shouldScanWslTarget,
    usesMirroredWslNetworking,
    wslLaunchCommand,
    wslTargetId,
} = require('../.test-build/runtimeTargets.js')

assert.deepEqual(nativeRuntimeTarget('win32'), {
    id: 'native',
    type: 'native',
    platform: 'windows',
    label: 'Windows',
})
assert.equal(nativeRuntimeTarget('freebsd'), null)
assert.equal(wslTargetId('Ubuntu Dev'), 'wsl:Ubuntu%20Dev')

assert.deepEqual(parseWslNames('\uFEFFUbuntu-22.04\r\nDebian\r\n'), ['Ubuntu-22.04', 'Debian'])
assert.deepEqual(
    parseWslNames('U\0b\0u\0n\0t\0u\0\r\0\n\0'),
    ['Ubuntu'],
    'UTF-16LE text decoded through a UTF-8 path is tolerated as a fallback',
)
assert.equal(
    decodeWslOutput(Buffer.from('\uFEFF开发环境\r\n', 'utf16le')),
    '开发环境\n',
    'actual UTF-16LE buffers preserve non-ASCII distribution names',
)

const targets = mergeWslTargets(
    'Ubuntu Dev\nDebian\n',
    'Debian\n',
    '  NAME             STATE       VERSION\n* Ubuntu Dev       Stopped     2\n  Debian           Running     1\n',
)
assert.deepEqual(targets, [
    {
        id: 'wsl:Ubuntu%20Dev',
        type: 'wsl',
        platform: 'linux',
        label: 'Ubuntu Dev',
        distro: 'Ubuntu Dev',
        wslVersion: 2,
        isDefault: true,
        state: 'stopped',
    },
    {
        id: 'wsl:Debian',
        type: 'wsl',
        platform: 'linux',
        label: 'Debian',
        distro: 'Debian',
        wslVersion: 1,
        isDefault: false,
        state: 'running',
    },
])
assert.equal(
    mergeWslTargets(
        'Ubuntu\nUbuntu Dev\n',
        '',
        '  Ubuntu Dev       Stopped     2\n* Ubuntu           Stopped     1\n',
    )[0].wslVersion,
    1,
    'a distro name is not enriched from a longer name sharing its prefix',
)
assert.equal(shouldScanWslTarget(targets[0], false), true)
assert.equal(shouldScanWslTarget({ ...targets[0], isDefault: false }, false), false)
assert.equal(shouldScanWslTarget({ ...targets[0], isDefault: false }, true), true)

const native = { target: nativeRuntimeTarget('win32') }
assert.equal(preferredRuntimeTarget([{ target: targets[1] }, native], null), native)
assert.equal(preferredRuntimeTarget([{ target: targets[1] }, native], targets[1].id).target, targets[1])

assert.deepEqual(
    wslLaunchCommand(targets[0], '/home/me/.local/bin/codex', ['--help'], 'C:\\Work Here', {
        WINDIR: 'D:\\Windows',
    }),
    {
        command: 'D:\\Windows\\System32\\wsl.exe',
        args: [
            '--distribution', 'Ubuntu Dev',
            '--cd', 'C:\\Work Here',
            '--exec', '/home/me/.local/bin/codex',
            '--help',
        ],
    },
)
assert.equal(isWindowsMountedWslPath('C:\\Users\\Jesse\\bin\\codex'), true)
assert.equal(isWindowsMountedWslPath('\\\\wsl.localhost\\Ubuntu\\home\\jesse\\codex'), false)
assert.equal(usesMirroredWslNetworking('C:\\Users\\Me', () => '[wsl2]\nnetworkingMode=mirrored\n'), true)
assert.equal(usesMirroredWslNetworking('C:\\Users\\Me', () => '[wsl2]\nnetworkingMode=nat\n'), false)

console.log('runtimeTargets.test.cjs: all assertions passed')
