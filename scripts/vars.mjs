import * as path from 'path'
import * as fs from 'fs'
import * as semver from 'semver'
import * as childProcess from 'child_process'

process.env.ARCH = ((process.env.ARCH || process.arch) === 'arm') ? 'armv7l' : (process.env.ARCH || process.arch)

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const electronInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../node_modules/electron/package.json')))

function describeVersion () {
    try {
        return childProcess.execSync('git describe --tags', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
        // No tag is reachable from HEAD — a clone without tags pushed, or a
        // shallow checkout. Shape the fallback like a post-tag describe so the
        // nightly branch below still fires instead of it naming a release.
        const appVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../app/package.json'))).version
        return `v${appVersion}-0-g0000000`
    }
}

export let version = describeVersion()
version = version.substring(1).trim()
version = version.replace('-', '-c')

if (version.includes('-c')) {
    version = semver.inc(version, 'prepatch').replace('-0', `-nightly.${process.env.REV ?? 0}`)
}

export const builtinPlugins = [
    'tabby-core',
    'tabby-settings',
    'tabby-terminal',
    'tabby-web',
    'tabby-community-color-schemes',
    'tabby-ssh',
    'tabby-serial',
    'tabby-telnet',
    'tabby-local',
    'tabby-electron',
    'tabby-linkifier',
    'tabby-auto-sudo-password',
    'tabby-ai',
]

export const packagesWithDocs = [
    ['.', 'tabby-core'],
    ['terminal', 'tabby-terminal'],
    ['local', 'tabby-local'],
    ['settings', 'tabby-settings'],
]

export const allPackages = [
    ...builtinPlugins,
    'web',
    'tabby-web-demo',
]

export const bundledModules = [
    '@angular',
    '@ng-bootstrap',
]
export const electronVersion = electronInfo.version

