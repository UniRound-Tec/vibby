function isPackagedAppInternalResource (candidate: string): boolean {
    const normalized = candidate.replace(/\//g, '\\').toLowerCase()
    return normalized.includes('\\windowsapps\\') && normalized.includes('\\app\\resources\\')
}

/**
 * Selects the first usable result emitted by `where` / `which`.
 *
 * Windows Store desktop apps can put private resources on PATH. `where` sees
 * those files, but other processes cannot execute them, so they are not CLI
 * installations and must not make an install card appear detected.
 */
export function selectLookupResult (output: string|null, windows = false): string|null {
    const candidates = output?.split(/\r?\n/).map(x => x.trim()).filter(x => x) ?? []
    return candidates.find(candidate => !windows || !isPackagedAppInternalResource(candidate)) ?? null
}

/** Extracts the current-user PATH from `reg.exe query HKCU\Environment /v Path`. */
export function parseWindowsRegistryPath (
    output: string|null,
    environment: Record<string, string|undefined> = {},
): string|null {
    const pathLine = output?.split(/\r?\n/).find(line => /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+/i.test(line))
    const value = pathLine?.replace(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+/i, '').trim()
    if (!value) {
        return null
    }
    const environmentEntries = Object.entries(environment)
    return value.replace(/%([^%]+)%/g, (match, name: string) => {
        return environmentEntries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? match
    })
}

/** Combines the process PATH with a freshly read Windows user PATH. */
export function mergeWindowsPath (
    processPath: string|undefined,
    userPath: string|null,
): string|null {
    const result: string[] = []
    const seen = new Set<string>()
    for (const entry of `${userPath ?? ''};${processPath ?? ''}`.split(';')) {
        const value = entry.trim()
        const key = value.replace(/[\\/]+$/, '').toLowerCase()
        if (value && !seen.has(key)) {
            seen.add(key)
            result.push(value)
        }
    }
    return result.length ? result.join(';') : null
}
