/** First Pi release whose extension lifecycle Vibby has verified end-to-end. */
export const MINIMUM_PI_MONITORING_VERSION = '0.82.1'

interface ParsedVersion {
    tuple: [number, number, number]
    prerelease: boolean
}

function parseVersion (value: string|null): ParsedVersion|null {
    const normalized = value ?? ''
    const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(normalized)
    return match
        ? {
            tuple: [Number(match[1]), Number(match[2]), Number(match[3])],
            prerelease: /^\s*v?\d+\.\d+\.\d+-/.test(normalized),
        }
        : null
}

/** Unknown/older Pi builds remain launchable, but are not advertised as fully monitored. */
export function supportsPiMonitoring (version: string|null): boolean {
    const current = parseVersion(version)
    const minimum = parseVersion(MINIMUM_PI_MONITORING_VERSION)!
    if (!current) {
        return false
    }
    for (let i = 0; i < current.tuple.length; i++) {
        if (current.tuple[i] !== minimum.tuple[i]) {
            return current.tuple[i] > minimum.tuple[i]
        }
    }
    return !current.prerelease
}
