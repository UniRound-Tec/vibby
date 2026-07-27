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
