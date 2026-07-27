/** Approximate card density retained while making every page end on a full row. */
export const MIN_LAUNCH_PAGE_CAPACITY = 8

export function launchPageCapacity (
    columnCount: number,
    minimum = MIN_LAUNCH_PAGE_CAPACITY,
): number {
    const columns = Number.isFinite(columnCount) && columnCount > 0
        ? Math.floor(columnCount)
        : 1
    return Math.ceil(minimum / columns) * columns
}
