export type AiCliLauncher = 'exe' | 'cmd' | 'ps1' | 'sh'

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
}

export interface DetectedCli {
    entry: AiCliRegistryEntry

    /** Resolved absolute path */
    command: string

    /** Determines the platform launch wrapping */
    launcher: AiCliLauncher

    /** null when version probing failed — not a blocker */
    version: string | null
}
