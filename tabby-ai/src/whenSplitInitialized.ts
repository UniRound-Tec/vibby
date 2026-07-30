import { SplitTabComponent } from 'tabby-core'

/**
 * Wait for SplitTab layout init. `initialized$` completes after one emit, so a
 * late `toPromise()` rejects with RxJS EmptyError — treat that as "already
 * done" (scanResults$ / tabsChanged$ revisits hit this regularly).
 */
export function whenSplitInitialized (tab: SplitTabComponent): Promise<void> {
    return Promise.resolve(tab.initialized$.toPromise()).then(
        () => undefined,
        () => undefined,
    )
}
