import { Observable, Subject } from 'rxjs'

export abstract class HostWindowService {

    /**
     * Fired once the window is visible
     */
    get windowShown$ (): Observable<void> { return this.windowShown }

    /**
     * Fired when the window close button is pressed
     */
    get windowCloseRequest$ (): Observable<void> { return this.windowCloseRequest }
    get windowMoved$ (): Observable<void> { return this.windowMoved }
    get windowFocused$ (): Observable<void> { return this.windowFocused }

    protected windowShown = new Subject<void>()
    protected windowCloseRequest = new Subject<void>()
    protected windowMoved = new Subject<void>()
    protected windowFocused = new Subject<void>()

    abstract readonly isFullscreen: boolean
    abstract reload (): void
    abstract setTitle (title?: string): void
    abstract toggleFullscreen (): void
    abstract minimize (): void
    abstract isMaximized (): boolean
    abstract toggleMaximize (): void
    abstract close (): void

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    openDevTools (): void { }

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    bringToFront (): void { }

    /**
     * Asks the host to hide the window to the system tray instead of closing
     * it. Returns true when the host took over — the caller must then leave
     * the window and its sessions alone. False means close normally.
     */
    hideToTray (): boolean { return false }
}
