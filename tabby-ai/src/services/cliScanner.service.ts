import { spawn, exec } from 'child_process'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { AI_CLI_REGISTRY } from '../registry'
import { AiCliLauncher, AiCliRegistryEntry, DetectedCli } from '../api'

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
    private logger: Logger

    constructor (
        private config: ConfigService,
        log: LogService,
    ) {
        this.logger = log.create('aiCliScanner')
    }

    /** Resolves once the first scan has completed; starts one if needed */
    ensureScanned (): Promise<DetectedCli[]> {
        return this.firstScan ?? this.scan()
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

    private async performScan (): Promise<DetectedCli[]> {
        await this.config.ready$.toPromise()
        this.scanning.next(true)
        try {
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
            ...WINDOWS ? [] : [path.join(os.homedir(), '.local', 'bin')],
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
        const output = await new Promise<string|null>(resolve => {
            exec(
                WINDOWS ? `where "${bin}"` : `which "${bin}"`,
                { timeout: PROBE_TIMEOUT, windowsHide: true },
                (err, stdout) => resolve(err ? null : stdout),
            )
        })
        return output?.split(/\r?\n/).map(x => x.trim()).find(x => x) ?? null
    }

    private async getNpmGlobalBinDirs (): Promise<string[]> {
        if (this.npmGlobalBin === undefined) {
            this.npmGlobalBin = await new Promise<string|null>(resolve => {
                exec('npm prefix -g', { timeout: SCAN_TIMEOUT, windowsHide: true }, (err, stdout) => {
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
            const child = spawn(cmd.command, cmd.args, {
                windowsHide: true,
                detached: !WINDOWS,
                stdio: ['ignore', 'pipe', 'pipe'],
            })
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
                killTree(child.pid)
                finish(null)
            }, timeout)
            child.stdout.on('data', d => output += d.toString())
            child.stderr.on('data', d => output += d.toString())
            child.on('error', () => finish(null))
            child.on('close', () => finish(output))
        })
    }

    private withTimeout<T> (promise: Promise<T>, ms: number, fallback: T): Promise<T> {
        return Promise.race([
            promise,
            new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
        ])
    }
}

