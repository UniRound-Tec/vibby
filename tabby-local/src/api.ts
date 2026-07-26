import { BaseTerminalProfile } from 'tabby-terminal'

export type ShellType = 'unix' | 'powershell' | 'cmd'

export interface Shell {
    id: string
    name: string
    command: string
    args?: string[]
    env: Record<string, string>

    /**
     * Base path to which shell's internal FS is relative
     * Currently used for WSL only
     */
    fsBase?: string

    cwd?: string

    /**
     * SVG icon
     */
    icon?: string

    shellType?: ShellType

    hidden?: boolean
}

/**
 * Extend to add support for more shells
 */
export abstract class ShellProvider {
    abstract provide (): Promise<Shell[]>
}


export interface SessionOptions {
    restoreFromPTYID: string | null
    command: string
    args: string[]
    cwd: string | null
    env: Record<string, string>
    /**
     * Paths prepended after all environment sources have been merged.
     *
     * Always present at runtime, including for a recovery token written before
     * this field existed: every route to Session.start() resolves the profile
     * through getConfigProxyForProfile, which merges the provider's
     * configDefaults over whatever came off disk.
     */
    pathPrefix: string[]
    width: number | null
    height: number | null
    shellType: ShellType | null
    pauseAfterExit: boolean
    runAsAdministrator: boolean
}

export interface LocalProfile extends BaseTerminalProfile {
    options: SessionOptions
}

export interface ChildProcess {
    pid: number
    ppid: number
    command: string
    commandLine?: string
}

export abstract class UACService {
    isAvailable = false

    abstract patchSessionOptionsForUAC (sessionOptions: SessionOptions): SessionOptions
}

export abstract class PTYProxy {
    abstract getID (): string
    abstract getPID (): Promise<number>
    abstract resize (columns: number, rows: number): Promise<void>
    abstract write (data: Buffer): Promise<void>
    abstract kill (signal?: string): Promise<void>
    abstract ackData (length: number): void
    abstract subscribe (event: string, handler: (..._: any[]) => void): void
    abstract unsubscribeAll (): void
    abstract getChildProcesses (): Promise<ChildProcess[]>
    abstract getTruePID (): Promise<number>
    abstract getWorkingDirectory (): Promise<string|null>
}

export abstract class PTYInterface {
    abstract spawn (...options: any[]): Promise<PTYProxy>
    abstract restore (id: string): Promise<PTYProxy|null>
}
