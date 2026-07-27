import { spawn, exec, execFile } from 'child_process'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { AI_CLI_REGISTRY } from '../registry'
import {
    AiCliLauncher, AiCliRegistryEntry, CliRuntimeTarget, DetectedCli, WslCliRuntimeTarget,
} from '../api'
import { mergeWindowsPath, parseWindowsRegistryPath, selectLookupResult } from '../binaryResolution'
import { scanResultForProfiles } from '../scanLifecycle'
import {
    decodeWslOutput, isWindowsMountedWslPath, mergeWslTargets, nativeRuntimeTarget, shouldScanWslTarget,
    wslExecutablePath, wslLaunchCommand,
} from '../runtimeTargets'
import { quoteSh } from '../paths'
import { supportsCodexHooks } from '../codexCapabilities'

const WINDOWS = process.platform === 'win32'
const PROBE_TIMEOUT = 2000
const SCAN_TIMEOUT = 8000
const WSL_SCAN_TIMEOUT = 12000
const WSL_RECORD = '__VIBBY_WSL_CLI__'
const WSL_SHELL_RECORD = '__VIBBY_WSL_SHELL__'

export function launcherFor (file: string): AiCliLauncher {
    const ext = path.extname(file).toLowerCase()
    if (ext === '.cmd' || ext === '.bat') {
        return 'cmd'
    }
    if (ext === '.ps1') {
        return 'ps1'
    }
    if (ext === '.exe') {
        return 'exe'
    }
    return WINDOWS ? 'exe' : 'sh'
}

/** Platform launch wrapping — npm shims on Windows cannot be spawned directly (spec §5) */
export function wrapCommand (command: string, args: string[], launcher: AiCliLauncher): { command: string, args: string[] } {
    if (launcher === 'cmd') {
        return { command: 'cmd.exe', args: ['/c', command, ...args] }
    }
    if (launcher === 'ps1') {
        return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args] }
    }
    return { command, args }
}

function killTree (pid: number|undefined): void {
    if (!pid) {
        return
    }
    if (WINDOWS) {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
        try {
            process.kill(-pid, 'SIGKILL')
        } catch {
            try {
                process.kill(pid, 'SIGKILL')
            } catch { }
        }
    }
}

async function exists (p: string): Promise<boolean> {
    try {
        await fs.access(p)
        return true
    } catch {
        return false
    }
}

@Injectable({ providedIn: 'root' })
export class CliScannerService {
    get scanResults$ (): Observable<DetectedCli[]> { return this.results }
    get scanResults (): DetectedCli[] { return this.results.value }
    get scanning$ (): Observable<boolean> { return this.scanning }
    get runtimeTargets (): readonly CliRuntimeTarget[] { return this.runtimeTargetsValue }

    private results = new BehaviorSubject<DetectedCli[]>([])
    private scanning = new BehaviorSubject<boolean>(false)
    private npmGlobalBin: string|null|undefined = undefined
    private currentScan: Promise<DetectedCli[]>|null = null
    private firstScan: Promise<DetectedCli[]>|null = null
    private shellPathProbe: Promise<string|null>|null = null
    private shellPathValue: string|null = null
    private runtimeTargetsValue: CliRuntimeTarget[] = []
    private wslShells = new Map<string, string>()
    private logger: Logger

    constructor (
        private config: ConfigService,
        log: LogService,
    ) {
        this.logger = log.create('aiCliScanner')
    }

    /** Returns the active/latest scan, starting the first one when needed. */
    ensureScanned (): Promise<DetectedCli[]> {
        return scanResultForProfiles(this.currentScan, this.firstScan, this.results.value, () => this.scan(true))
    }

    /**
     * PATH as the user's login shell sees it, including Windows user-PATH
     * changes made after this GUI process started; null when probing failed.
     * Launched profiles need it too: a CLI resolved through this PATH usually
     * starts with `#!/usr/bin/env node`, which has to make the same lookup.
     */
    get shellPath (): string|null {
        return this.shellPathValue
    }

    async scan (includeStoppedWsl = true): Promise<DetectedCli[]> {
        if (this.currentScan) {
            return this.currentScan
        }
        this.currentScan = this.performScan(includeStoppedWsl).finally(() => {
            this.currentScan = null
        })
        this.firstScan ??= this.currentScan
        return this.currentScan
    }

    /** Re-read package-manager locations and login-shell PATH after an install */
    async refresh (includeStoppedWsl = true): Promise<DetectedCli[]> {
        if (this.currentScan) {
            await this.currentScan
        }
        this.npmGlobalBin = undefined
        this.shellPathProbe = null
        this.shellPathValue = null
        this.wslShells.clear()
        return this.scan(includeStoppedWsl)
    }

    private async performScan (includeStoppedWsl: boolean): Promise<DetectedCli[]> {
        await this.config.ready$.toPromise()
        this.scanning.next(true)
        try {
            // must land before the first `which`: a GUI-launched app on
            // macOS/Linux carries a minimal PATH without Homebrew/npm/nvm dirs
            await this.ensureShellPath()
            const hidden: string[] = this.config.store.aiCli.scanner.hidden
            const entries = AI_CLI_REGISTRY.filter(x => !hidden.includes(x.id))
            const nativeTarget = nativeRuntimeTarget()
            const nativeDetections = nativeTarget ? await this.withTimeout(
                Promise.all(entries.map(x => this.detectNative(x, nativeTarget))),
                SCAN_TIMEOUT,
                [] as (DetectedCli|null)[],
            ) : []

            const wslTargets = await this.enumerateWslTargets()
            this.runtimeTargetsValue = [
                ...nativeTarget ? [nativeTarget] : [],
                ...wslTargets,
            ]
            const excludedWsl = new Set(
                (this.config.store.aiCli.scanner.wsl.excludedDistributions as string[])
                    .map(name => name.toLowerCase()),
            )
            const wslDetections = await Promise.all(
                wslTargets
                    .filter(target => !excludedWsl.has(target.distro.toLowerCase()))
                    .filter(target => shouldScanWslTarget(target, includeStoppedWsl))
                    .map(target => this.withTimeout(
                        this.detectInWsl(target, entries),
                        WSL_SCAN_TIMEOUT,
                        [] as DetectedCli[],
                    )),
            )
            const found = [
                ...nativeDetections.filter((x): x is DetectedCli => !!x),
                ...wslDetections.flat(),
            ]
            this.logger.info(`Scan complete: ${found.map(x =>
                `${x.entry.id}@${x.version ?? '?'}[${x.target.label}]`,
            ).join(', ') || 'none found'}`)
            this.results.next(found)
            return found
        } finally {
            this.scanning.next(false)
        }
    }

    private async detectNative (
        entry: AiCliRegistryEntry,
        target: CliRuntimeTarget,
    ): Promise<DetectedCli|null> {
        try {
            const command = await this.resolveBinary(entry)
            if (!command) {
                return null
            }
            const launcher = launcherFor(command)
            const version = await this.probeVersion(entry, command, launcher)
            const monitoring = entry.id === 'codex'
                ? await this.probeCodexMonitoring(command, launcher)
                : entry.tier
            return { entry, target, command, launcher, version, monitoring }
        } catch (e) {
            this.logger.warn(`Failed to detect ${entry.id}:`, e)
            return null
        }
    }

    private async enumerateWslTargets (): Promise<WslCliRuntimeTarget[]> {
        if (!WINDOWS || this.config.store.aiCli.scanner.wsl?.enabled === false) {
            return []
        }
        const wsl = wslExecutablePath()
        const env = { ...process.env, WSL_UTF8: '1' }
        const [names, running, verbose] = await Promise.all([
            this.runTextCommand(wsl, ['--list', '--quiet'], PROBE_TIMEOUT, env),
            this.runTextCommand(wsl, ['--list', '--running', '--quiet'], PROBE_TIMEOUT, env),
            this.runTextCommand(wsl, ['--list', '--verbose'], PROBE_TIMEOUT, env),
        ])
        if (names === null) {
            this.logger.info('WSL unavailable or not configured')
            return []
        }
        return mergeWslTargets(names, running ?? '', verbose ?? '')
    }

    private async detectInWsl (
        target: WslCliRuntimeTarget,
        entries: AiCliRegistryEntry[],
    ): Promise<DetectedCli[]> {
        try {
            const commands = await this.resolveWslBinaries(target, entries)
            const detections: (DetectedCli|null)[] = await Promise.all(entries.map(async (
                entry,
            ): Promise<DetectedCli|null> => {
                const command = commands.get(entry.id)
                if (!command) {
                    return null
                }
                const version = await this.probeWslVersion(target, entry, command)
                return {
                    entry,
                    target,
                    command,
                    launcher: 'sh' as const,
                    version,
                    // Ordinary WSL terminals are launch-only in this milestone.
                    monitoring: entry.id === 'codex' ? 'launch' : entry.tier,
                }
            }))
            return detections.filter((item): item is DetectedCli => !!item)
        } catch (error) {
            this.logger.warn(`Failed to scan WSL distribution ${target.distro}:`, error)
            return []
        }
    }

    private async getWslShell (target: WslCliRuntimeTarget): Promise<string> {
        const cached = this.wslShells.get(target.id)
        if (cached) {
            return cached
        }
        const output = await this.runCaptured(
            wslLaunchCommand(
                target,
                '/bin/sh',
                ['-lc', `printf '${WSL_SHELL_RECORD}%s\\n' "\${SHELL:-/bin/sh}"`],
            ),
            PROBE_TIMEOUT,
            { ...process.env, WSL_UTF8: '1' },
        )
        const shell = output
            ?.split(/\r?\n/)
            .find(line => line.startsWith(WSL_SHELL_RECORD))
            ?.slice(WSL_SHELL_RECORD.length)
            .trim()
        const result = shell?.startsWith('/') ? shell : '/bin/sh'
        this.wslShells.set(target.id, result)
        return result
    }

    private async resolveWslBinaries (
        target: WslCliRuntimeTarget,
        entries: AiCliRegistryEntry[],
    ): Promise<Map<string, string>> {
        const functions = entries.map(entry => [
            'vibby_find',
            quoteSh(entry.id),
            ...entry.binaries.map(quoteSh),
        ].join(' ')).join('\n')
        const script = [
            'vibby_find () {',
            '  vibby_id=$1',
            '  shift',
            '  for vibby_bin in "$@"; do',
            '    vibby_old_ifs=$IFS',
            '    IFS=:',
            '    for vibby_dir in $PATH; do',
            '      IFS=$vibby_old_ifs',
            '      [ -n "$vibby_dir" ] || vibby_dir=.',
            '      vibby_candidate=$vibby_dir/$vibby_bin',
            '      if [ -f "$vibby_candidate" ] && [ -x "$vibby_candidate" ]; then',
            '        vibby_real=$(readlink -f "$vibby_candidate" 2>/dev/null || printf "%s" "$vibby_candidate")',
            '        vibby_windows=$(wslpath -w "$vibby_real" 2>/dev/null || true)',
            `        printf '${WSL_RECORD}%s\\t%s\\t%s\\n' "$vibby_id" "$vibby_real" "$vibby_windows"`,
            '      fi',
            '      IFS=:',
            '    done',
            '    IFS=$vibby_old_ifs',
            '  done',
            '}',
            // Launch-time metadata, captured here because arming cannot afford
            // wsl.exe round-trips (the PTY spawn races it): where C:\ is
            // mounted, and whether Windows binaries execute at all (binfmt
            // interop — systemd distros routinely lose the registration).
            `vibby_mount=$(wslpath -a -u 'C:\\' 2>/dev/null || true)`,
            `[ -n "$vibby_mount" ] && printf '${WSL_RECORD}%s\\t%s\\t%s\\n' __mount__ "$vibby_mount" -`,
            `vibby_curl=$(wslpath -a -u 'C:\\Windows\\System32\\curl.exe' 2>/dev/null || true)`,
            `[ -n "$vibby_curl" ] && "$vibby_curl" --version >/dev/null 2>&1 && printf '${WSL_RECORD}%s\\t%s\\t%s\\n' __interop__ ok -`,
            functions,
        ].join('\n')
        const shell = await this.getWslShell(target)
        let output = await this.runCaptured(
            wslLaunchCommand(target, shell, ['-i', '-l', '-c', script]),
            WSL_SCAN_TIMEOUT,
            { ...process.env, WSL_UTF8: '1' },
        )
        if (!output?.includes(WSL_RECORD) && shell !== '/bin/sh') {
            output = await this.runCaptured(
                wslLaunchCommand(target, '/bin/sh', ['-lc', script]),
                WSL_SCAN_TIMEOUT,
                { ...process.env, WSL_UTF8: '1' },
            )
        }
        const commands = new Map<string, string>()
        target.windowsInterop = false
        for (const line of output?.split(/\r?\n/) ?? []) {
            const marker = line.indexOf(WSL_RECORD)
            if (marker === -1) {
                continue
            }
            const [id, resolved, windowsPath] = line.slice(marker + WSL_RECORD.length).split('\t')
            if (id === '__mount__') {
                target.windowsMountRoot = resolved || null
                continue
            }
            if (id === '__interop__') {
                target.windowsInterop = true
                continue
            }
            if (id && resolved && windowsPath && !isWindowsMountedWslPath(windowsPath) && !commands.has(id)) {
                commands.set(id, resolved)
            }
        }
        return commands
    }

    private async probeWslVersion (
        target: WslCliRuntimeTarget,
        entry: AiCliRegistryEntry,
        command: string,
    ): Promise<string|null> {
        const output = await this.runCaptured(
            wslLaunchCommand(target, command, entry.versionArgs),
            PROBE_TIMEOUT,
            { ...process.env, WSL_UTF8: '1' },
        )
        return output === null ? null : entry.versionPattern.exec(output)?.[1] ?? null
    }

    private runTextCommand (
        command: string,
        args: string[],
        timeout: number,
        env: Record<string, string|undefined>,
    ): Promise<string|null> {
        return new Promise(resolve => {
            execFile(command, args, {
                timeout,
                windowsHide: true,
                env,
                maxBuffer: 1024 * 1024,
            }, (error, stdout) => resolve(error ? null : decodeWslOutput(stdout)))
        })
    }

    private async resolveBinary (entry: AiCliRegistryEntry): Promise<string|null> {
        for (const bin of entry.binaries) {
            const hit = await this.lookupInPath(bin)
            if (hit) {
                return hit
            }
        }

        const dirs = [
            ...await this.getNpmGlobalBinDirs(),
            // shellPath usually covers these, but a broken rc file must not
            // take detection down with it — the usual suspects stay hardcoded
            ...WINDOWS ? [] : [
                path.join(os.homedir(), '.local', 'bin'),
                '/opt/homebrew/bin',
                '/usr/local/bin',
                path.join(os.homedir(), '.bun', 'bin'),
                path.join(os.homedir(), '.volta', 'bin'),
            ],
            ...this.config.store.aiCli.scanner.extraPaths as string[],
        ]
        const extensions = WINDOWS ? ['.cmd', '.exe', '.bat', '.ps1'] : ['']
        for (const dir of dirs) {
            for (const bin of entry.binaries) {
                for (const ext of extensions) {
                    const candidate = path.join(dir, bin + ext)
                    if (await exists(candidate)) {
                        return candidate
                    }
                }
            }
        }
        return null
    }

    private async lookupInPath (bin: string): Promise<string|null> {
        // execFile, not exec: `bin` comes from the registry today, but this
        // repo has already had to fix two shell-injection bugs of exactly this
        // shape (74f8e4f2, 2e4a5e6f) and there is no reason to spawn a shell
        const output = await new Promise<string|null>(resolve => {
            execFile(
                WINDOWS ? 'where' : 'which',
                [bin],
                { timeout: PROBE_TIMEOUT, windowsHide: true, env: this.execEnv() },
                (err, stdout) => resolve(err ? null : stdout),
            )
        })
        return selectLookupResult(output, WINDOWS)
    }

    /**
     * One `$SHELL -ilc env` per app run. Interactive as well as login: nvm
     * and friends append to PATH from .zshrc/.bashrc, which a plain login
     * shell never reads. Output is scanned for the PATH= line only, so rc
     * banners and prompt noise cannot poison the result.
     */
    private ensureShellPath (): Promise<string|null> {
        if (WINDOWS) {
            this.shellPathProbe ??= new Promise<string|null>(resolve => {
                execFile(
                    'reg.exe',
                    ['query', 'HKCU\\Environment', '/v', 'Path'],
                    { timeout: PROBE_TIMEOUT, windowsHide: true },
                    (err, stdout) => resolve(err ? null : parseWindowsRegistryPath(stdout, process.env)),
                )
            }).then(userPath => {
                const value = mergeWindowsPath(process.env.PATH, userPath)
                this.shellPathValue = value
                this.logger.info(userPath ? 'Refreshed Windows user PATH' : 'Windows user PATH probe failed, using process PATH')
                return value
            })
            return this.shellPathProbe
        }
        this.shellPathProbe ??= new Promise<string|null>(resolve => {
            execFile(
                process.env.SHELL ?? '/bin/sh',
                ['-i', '-l', '-c', 'env'],
                { timeout: 4000 },
                (err, stdout) => {
                    const line = err ? undefined : stdout.split('\n').find(x => x.startsWith('PATH='))
                    const value = line?.slice('PATH='.length).trim()
                    resolve(value ? value : null)
                },
            )
        }).then(shellPath => {
            this.shellPathValue = shellPath
            this.logger.info(shellPath ? `Login shell PATH: ${shellPath}` : 'Login shell PATH probe failed, using process PATH')
            return shellPath
        })
        return this.shellPathProbe
    }

    /** Environment for probes and version checks — process env plus the real PATH */
    private execEnv (): Record<string, string|undefined> {
        return this.shellPathValue ? { ...process.env, PATH: this.shellPathValue } : process.env
    }

    private async getNpmGlobalBinDirs (): Promise<string[]> {
        if (this.npmGlobalBin === undefined) {
            this.npmGlobalBin = await new Promise<string|null>(resolve => {
                exec('npm prefix -g', { timeout: SCAN_TIMEOUT, windowsHide: true, env: this.execEnv() }, (err, stdout) => {
                    resolve(err ? null : stdout.trim())
                })
            })
        }
        if (!this.npmGlobalBin) {
            return []
        }
        return [WINDOWS ? this.npmGlobalBin : path.join(this.npmGlobalBin, 'bin')]
    }

    private async probeVersion (entry: AiCliRegistryEntry, command: string, launcher: AiCliLauncher): Promise<string|null> {
        const output = await this.runCaptured(wrapCommand(command, entry.versionArgs, launcher), PROBE_TIMEOUT)
        if (output === null) {
            return null
        }
        return entry.versionPattern.exec(output)?.[1] ?? null
    }

    private async probeCodexMonitoring (
        command: string,
        launcher: AiCliLauncher,
    ): Promise<'full'|'launch'> {
        const features = await this.runCaptured(
            wrapCommand(command, ['features', 'list'], launcher),
            PROBE_TIMEOUT,
        )
        return supportsCodexHooks(features) ? 'full' : 'launch'
    }

    /** Runs a process, captures stdout+stderr, kills the whole process tree on timeout */
    private runCaptured (
        cmd: { command: string, args: string[] },
        timeout: number,
        environment = this.execEnv(),
    ): Promise<string|null> {
        return new Promise(resolve => {
            let output = ''
            const spawned = (() => {
                try {
                    return spawn(cmd.command, cmd.args, {
                        windowsHide: true,
                        detached: !WINDOWS,
                        stdio: ['ignore', 'pipe', 'pipe'],
                        // the CLI is usually an `#!/usr/bin/env node` script — the
                        // interpreter lookup needs the same PATH that found the CLI
                        env: environment,
                    })
                } catch {
                    return null
                }
            })()
            if (!spawned) {
                // Finding the executable is enough for detection. Version
                // probing is explicitly best-effort and must not turn an
                // installed CLI into a grey "install" card.
                resolve(null)
                return
            }
            // holder rather than two bare locals: `finish` has to clear the
            // timer that is only armed after `finish` itself is defined
            const pending: { done: boolean, timer?: ReturnType<typeof setTimeout> } = { done: false }
            const finish = (result: string|null) => {
                if (pending.done) {
                    return
                }
                pending.done = true
                clearTimeout(pending.timer)
                resolve(result)
            }
            pending.timer = setTimeout(() => {
                killTree(spawned.pid)
                finish(null)
            }, timeout)
            spawned.stdout.on('data', d => output += d.toString())
            spawned.stderr.on('data', d => output += d.toString())
            spawned.on('error', () => finish(null))
            spawned.on('close', () => finish(output))
        })
    }

    private withTimeout<T> (promise: Promise<T>, ms: number, fallback: T): Promise<T> {
        return Promise.race([
            promise,
            new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
        ])
    }
}
