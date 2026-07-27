/**
 * Returns the scan result profile providers should use.
 *
 * Kept pure so the lifecycle around the scanner's BehaviorSubject can be
 * tested without constructing Angular services.
 */
export function scanResultForProfiles<T> (
    currentScan: Promise<T>|null,
    firstScan: Promise<T>|null,
    latest: T,
    startScan: () => Promise<T>,
): Promise<T> {
    if (currentScan) {
        return currentScan
    }
    if (firstScan) {
        return Promise.resolve(latest)
    }
    return startScan()
}
