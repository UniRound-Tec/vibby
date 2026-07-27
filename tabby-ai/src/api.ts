export type AiCliLauncher = 'exe' | 'cmd' | 'ps1' | 'sh'
export type CliNativePlatform = 'windows' | 'linux' | 'macos'

export interface NativeCliRuntimeTarget {
    id: 'native'
    type: 'native'
    platform: CliNativePlatform
    label: string
}

export interface WslCliRuntimeTarget {
    id: string
    type: 'wsl'
    platform: 'linux'
    label: string
    distro: string
    wslVersion: 1 | 2 | null
    isDefault: boolean
    state: 'running' | 'stopped' | 'unknown'
}

export type CliRuntimeTarget = NativeCliRuntimeTarget | WslCliRuntimeTarget

export interface AiCliRegistryEntry {
    /** Stable identifier, becomes profile options.aiCli.kind */
    id: string

    /** Product name, not translated */
    name: string

    /** Executable names to probe, without platform-specific extensions */
    binaries: string[]

    versionArgs: string[]
    versionPattern: RegExp

    /** Default arguments when launching a session */
    launchArgs?: string[]

    /** Distinctive package/script fragments found in process command lines */
    runtimeMarkers?: string[]

    /** Inline SVG */
    icon: string

    /** 'full' = event adapter available (M2+); 'launch' = launch only */
    tier: 'full' | 'launch'

    docsUrl?: string
}

export interface AiCliMetadata {
    /** Registry entry id, e.g. 'claude-code' */
    kind: string | null
    version: string | null

    /** Optional name supplied for this individual launch */
    sessionName?: string|null

    /** Runtime selected for this launch. Missing on pre-WSL recovery tokens. */
    targetId?: string|null

    /** Target-native cwd. WSL paths must not be put in SessionOptions.cwd on Windows. */
    targetCwd?: string|null
}

export interface DetectedCli {
    entry: AiCliRegistryEntry

    /** The environment that owns command and version. */
    target: CliRuntimeTarget

    /** Resolved absolute path inside target */
    command: string

    /** Determines the platform launch wrapping */
    launcher: AiCliLauncher

    /** null when version probing failed — not a blocker */
    version: string | null

    /** Monitoring support for this exact CLI + target combination. */
    monitoring: 'full' | 'launch'
}
