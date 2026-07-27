import { spawn, exec, execFile } from 'child_process'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { AI_CLI_REGISTRY } from '../registry'
import { AiCliLauncher, AiCliRegistryEntry, DetectedCli } from '../api'
import { mergeWindowsPath, parseWindowsRegistryPath, selectLookupResult } from '../binaryResolution'
import { scanResultForProfiles } from '../scanLifecycle'

const WINDOWS = process.platform === 'win32'
const PROBE_TIMEOUT = 2000
const SCAN_TIMEOUT = 5000

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

    private results = new BehaviorSubject<DetectedCli[]>([])
    private scanning = new BehaviorSubject<boolean>(false)
    private npmGlobalBin: string|null|undefined = undefined
    private currentScan: Promise<DetectedCli[]>|null = null
    private firstScan: Promise<DetectedCli[]>|null = null
    private shellPathProbe: Promise<string|null>|null = null
    private shellPathValue: string|null = null
    private logger: Logger

    constructor (
        private config: ConfigService,
        log: LogService,
    ) {
        this.logger = log.create('aiCliScanner')
    }

    /** Returns the active/latest scan, starting the first one when needed. */
    ensureScanned (): Promise<DetectedCli[]> {
        return scanResultForProfiles(this.currentScan, this.firstScan, this.results.value, () => this.scan())
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

    async scan (): Promise<DetectedCli[]> {
        if (this.currentScan) {
            return this.currentScan
        }
        this.currentScan = this.performScan().finally(() => {
            this.currentScan = null
        })
        this.firstScan ??= this.currentScan
        return this.currentScan
    }

    /** Re-read package-manager locations and login-shell PATH after an install */
    async refresh (): Promise<DetectedCli[]> {
        if (this.currentScan) {
            await this.currentScan
        }
        this.npmGlobalBin = undefined
        this.shellPathProbe = null
        this.shellPathValue = null
        return this.scan()
    }

    private async performScan (): Promise<DetectedCli[]> {
        await this.config.ready$.toPromise()
        this.scanning.next(true)
        try {
            // must land before the first `which`: a GUI-launched app on
            // macOS/Linux carries a minimal PATH without Homebrew/npm/nvm dirs
            await this.ensureShellPath()
            const hidden: string[] = this.config.store.aiCli.scanner.hidden
            const entries = AI_CLI_REGISTRY.filter(x => !hidden.includes(x.id))
            const detections = await this.withTimeout(
                Promise.all(entries.map(x => this.detect(x))),
                SCAN_TIMEOUT,
                [] as (DetectedCli|null)[],
            )
            const found = detections.filter((x): x is DetectedCli => !!x)
            this.logger.info(`Scan complete: ${found.map(x => `${x.entry.id}@${x.version ?? '?'}`).join(', ') || 'none found'}`)
            this.results.next(found)
            return found
        } finally {
            this.scanning.next(false)
        }
    }

    private async detect (entry: AiCliRegistryEntry): Promise<DetectedCli|null> {
        try {
            const command = await this.resolveBinary(entry)
            if (!command) {
                return null
            }
            const launcher = launcherFor(command)
            const version = await this.probeVersion(entry, command, launcher)
            return { entry, command, launcher, version }
        } catch (e) {
            this.logger.warn(`Failed to detect ${entry.id}:`, e)
            return null
        }
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

    /** Runs a process, captures stdout+stderr, kills the whole process tree on timeout */
    private runCaptured (cmd: { command: string, args: string[] }, timeout: number): Promise<string|null> {
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
                        env: this.execEnv(),
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
