import * as path from 'path'
import * as fs from 'fs'
import { execFile } from 'child_process'

import { CliNativePlatform, CliRuntimeTarget, NativeCliRuntimeTarget, WslCliRuntimeTarget } from './api'

const WSL_TARGET_PREFIX = 'wsl:'

export function nativePlatformFor (platform = process.platform): CliNativePlatform|null {
    if (platform === 'win32') {
        return 'windows'
    }
    if (platform === 'darwin') {
        return 'macos'
    }
    if (platform === 'linux') {
        return 'linux'
    }
    return null
}

export function nativeRuntimeTarget (platform = process.platform): NativeCliRuntimeTarget|null {
    const nativePlatform = nativePlatformFor(platform)
    return nativePlatform ? {
        id: 'native',
        type: 'native',
        platform: nativePlatform,
        label: nativePlatform === 'windows' ? 'Windows' : nativePlatform === 'macos' ? 'macOS' : 'Linux',
    } : null
}

export function wslTargetId (distro: string): string {
    return `${WSL_TARGET_PREFIX}${encodeURIComponent(distro)}`
}

/** Adds variables to WSLENV without discarding the user's flags or entries. */
export function appendWslenv (value: string|undefined, names: string[]): string {
    const entries = (value ?? '').split(':').filter(Boolean)
    const existing = new Set(entries.map(entry => entry.split('/', 1)[0].toUpperCase()))
    for (const name of names) {
        if (!existing.has(name.toUpperCase())) {
            entries.push(name)
            existing.add(name.toUpperCase())
        }
    }
    return entries.join(':')
}

export function wslExecutablePath (environment = process.env): string {
    // win32 join explicitly: this is a Windows path by definition, and the
    // pure-module tests run on Linux CI where the platform default is posix
    return path.win32.join(environment.WINDIR ?? environment.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
}

function cleanWslOutput (value: string): string {
    return value.replace(/^\uFEFF/, '').replace(/\0/g, '').replace(/\r/g, '')
}

export function decodeWslOutput (value: string|Buffer): string {
    if (typeof value === 'string') {
        return cleanWslOutput(value)
    }
    const utf16 = value.length >= 2 && (
        value[0] === 0xff && value[1] === 0xfe ||
        value.subarray(1, Math.min(value.length, 64)).filter((_, index) => index % 2 === 0 && value[index + 1] === 0).length >= 4
    )
    return cleanWslOutput(value.toString(utf16 ? 'utf16le' : 'utf8'))
}

export function parseWslNames (value: string): string[] {
    return cleanWslOutput(value)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
}

export interface WslVerboseMetadata {
    distro: string
    isDefault: boolean
    version: 1 | 2 | null
}

/**
 * Verbose WSL output has no stable machine format. Names come from --quiet;
 * this parser only enriches them from the default marker and trailing version.
 */
export function parseWslVerbose (
    value: string,
    names: string[],
): WslVerboseMetadata[] {
    const lines = cleanWslOutput(value).split('\n')
    return names.map(distro => {
        const matching = lines.find(line => {
            const withoutMarker = line.replace(/^\s*\*\s*/, '').trimStart()
            return withoutMarker.startsWith(distro) &&
                (withoutMarker.length === distro.length || /^\s{2,}/.test(withoutMarker.slice(distro.length)))
        })
        const version = matching?.match(/\s([12])\s*$/)?.[1]
        return {
            distro,
            isDefault: !!matching && /^\s*\*/.test(matching),
            version: version === '1' ? 1 : version === '2' ? 2 : null,
        }
    })
}

export function mergeWslTargets (
    namesOutput: string,
    runningOutput: string,
    verboseOutput: string,
): WslCliRuntimeTarget[] {
    const names = parseWslNames(namesOutput)
    const running = new Set(parseWslNames(runningOutput))
    const metadata = new Map(parseWslVerbose(verboseOutput, names).map(item => [item.distro, item]))
    return names.map(distro => {
        const meta = metadata.get(distro)
        return {
            id: wslTargetId(distro),
            type: 'wsl',
            platform: 'linux',
            label: distro,
            distro,
            wslVersion: meta?.version ?? null,
            isDefault: meta?.isDefault ?? false,
            state: running.has(distro) ? 'running' : 'stopped',
        }
    })
}

export function shouldScanWslTarget (
    target: WslCliRuntimeTarget,
    explicit: boolean,
): boolean {
    return explicit || target.isDefault || target.state === 'running'
}

export function preferredRuntimeTarget<T extends { target: CliRuntimeTarget }> (
    values: T[],
    preferredId?: string|null,
): T|null {
    if (!values.length) {
        return null
    }
    return values.find(item => item.target.id === preferredId) ??
        values.find(item => item.target.type === 'native') ??
        values.find(item => item.target.type === 'wsl' && item.target.isDefault) ??
        [...values].sort((a, b) => a.target.label.localeCompare(b.target.label))[0]
}

export function wslLaunchCommand (
    target: WslCliRuntimeTarget,
    executable: string,
    args: string[],
    cwd?: string|null,
    environment = process.env,
): { command: string, args: string[] } {
    const targetCwd = cwd?.trim()
    return {
        command: wslExecutablePath(environment),
        args: [
            '--distribution',
            target.distro,
            '--cd',
            targetCwd ? targetCwd : '~',
            '--exec',
            executable,
            ...args,
        ],
    }
}

export function isWindowsMountedWslPath (windowsPath: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(windowsPath.trim())
}

/**
 * Synchronous drive-path translation from the C:\ mount point captured at
 * scan time (`wslpath -a -u 'C:\'` → e.g. "/mnt/c/", or "/c/" for a custom
 * automount root). The async wslpath round-trip does the same job, but it
 * costs hundreds of milliseconds — which arming cannot afford, because the
 * PTY spawns as soon as the frontend is ready and injection has to be done
 * by then.
 */
export function translateWindowsPathWithMountRoot (
    cDriveMountRoot: string,
    windowsPath: string,
): string|null {
    const mount = /^(.*\/)[Cc]\/?$/.exec(cDriveMountRoot.trim())
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath.trim())
    if (!mount || !drive) {
        return null
    }
    return `${mount[1]}${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
}

export function translateWindowsPathForWsl (
    target: WslCliRuntimeTarget,
    windowsPath: string,
    timeout = 3000,
): Promise<string|null> {
    return new Promise(resolve => {
        execFile(
            wslExecutablePath(),
            ['--distribution', target.distro, '--exec', 'wslpath', '-a', '-u', windowsPath],
            {
                timeout,
                windowsHide: true,
                env: { ...process.env, WSL_UTF8: '1' },
                encoding: 'utf8',
            },
            (error, stdout) => resolve(error ? null : stdout.trim() || null),
        )
    })
}

/**
 * Whether the distro can execute Windows binaries at all. WSL registers a
 * binfmt_misc handler for PE executables, but a distro with systemd enabled
 * loses it whenever systemd-binfmt starts without WSL's config file present —
 * stock Ubuntu-22.04 ships exactly this. The hook bridge's curl.exe lane
 * rides that handler, so probe by running the real thing rather than
 * trusting that the mount implies interop.
 *
 * Takes the Windows path and resolves it with wslpath inside the same probe:
 * arming already races the PTY spawn, so this must not have to wait for a
 * separate translation round-trip first.
 */
export function windowsExecutableRunsInWsl (
    target: WslCliRuntimeTarget,
    executableWindowsPath: string,
    timeout = 3000,
): Promise<boolean> {
    const quoted = `'${executableWindowsPath.replace(/'/g, `'\\''`)}'`
    return new Promise(resolve => {
        execFile(
            wslExecutablePath(),
            [
                '--distribution', target.distro, '--exec', '/bin/sh', '-c',
                `"$(wslpath -a -u ${quoted})" --version >/dev/null 2>&1`,
            ],
            {
                timeout,
                windowsHide: true,
                env: { ...process.env, WSL_UTF8: '1' },
                encoding: 'utf8',
            },
            error => resolve(!error),
        )
    })
}

export function wslIpv4Address (
    target: WslCliRuntimeTarget,
    timeout = 3000,
): Promise<string|null> {
    return new Promise(resolve => {
        execFile(
            wslExecutablePath(),
            ['--distribution', target.distro, '--exec', 'hostname', '-I'],
            {
                timeout,
                windowsHide: true,
                env: { ...process.env, WSL_UTF8: '1' },
                encoding: 'utf8',
            },
            (error, stdout) => {
                if (error) {
                    resolve(null)
                    return
                }
                resolve(stdout.split(/\s+/).find(value => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) ?? null)
            },
        )
    })
}

export function usesMirroredWslNetworking (
    userProfile = process.env.USERPROFILE,
    read = (file: string): string => fs.readFileSync(file, 'utf8'),
): boolean {
    if (!userProfile) {
        return false
    }
    try {
        const config = read(path.join(userProfile, '.wslconfig'))
        return /^\s*networkingMode\s*=\s*mirrored\s*(?:[#;].*)?$/im.test(config)
    } catch {
        return false
    }
}
