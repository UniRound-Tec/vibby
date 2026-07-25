import { BaseTabComponent } from '../components/baseTab.component'

/**
 * Allows plugins to replace the default "duplicate this pane" split behavior.
 */
export abstract class SplitTabHandler {
    abstract supports (tab: BaseTabComponent): boolean

    abstract create (tab: BaseTabComponent): Promise<BaseTabComponent|null>
}
