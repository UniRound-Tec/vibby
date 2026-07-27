import type { BrowserWindow, TouchBar } from 'electron'
import { Injectable, Inject, Injector, NgZone } from '@angular/core'
import { BootstrapData, BOOTSTRAP_DATA, ConfigService, HostWindowService } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

export interface Bounds {
    x: number
    y: number
    width: number
    height: number
}

@Injectable({ providedIn: 'root' })
export class ElectronHostWindow extends HostWindowService {
    get isFullscreen (): boolean { return this._isFullscreen }

    private _isFullscreen = false
    private _isMaximized = false

    constructor (
        zone: NgZone,
        private electron: ElectronService,
        @Inject(BOOTSTRAP_DATA) private bootstrapData: BootstrapData,
        /**
         * ConfigService cannot be injected here: it depends on PlatformService,
         * which depends on this service, and asking for it during construction
         * closes that loop into an NG0200 that fails the whole bootstrap. It is
         * only needed long after startup, so hideToTray() resolves it on demand.
         */
        private injector: Injector,
    ) {
        super()
        electron.ipcRenderer.on('host:window-enter-full-screen', () => zone.run(() => {
            this._isFullscreen = true
        }))

        electron.ipcRenderer.on('host:window-leave-full-screen', () => zone.run(() => {
            this._isFullscreen = false
        }))

        electron.ipcRenderer.on('host:window-shown', () => zone.run(() => this.windowShown.next()))

        electron.ipcRenderer.on('host:window-close-request', () => zone.run(() => {
            this.windowCloseRequest.next()
        }))

        electron.ipcRenderer.on('host:window-moved', () => zone.run(() => {
            this.windowMoved.next()
        }))

        electron.ipcRenderer.on('host:window-focused', () => zone.run(() => {
            this.windowFocused.next()
        }))

        electron.ipcRenderer.on('host:became-main-window', () => zone.run(() => {
            this.bootstrapData.isMainWindow = true
        }))

        electron.ipcRenderer.on('host:window-maximized', () => zone.run(() => {
            this._isMaximized = true
        }))

        electron.ipcRenderer.on('host:window-unmaximized', () => zone.run(() => {
            this._isMaximized = false
        }))

        this._isMaximized = this.getWindow().isMaximized()
    }

    getWindow (): BrowserWindow {
        return this.electron.BrowserWindow.fromId(this.bootstrapData.windowID)!
    }

    openDevTools (): void {
        this.getWindow().webContents.openDevTools({ mode: 'undocked' })
    }

    reload (): void {
        this.getWindow().reload()
    }

    setTitle (title?: string): void {
        this.electron.ipcRenderer.send('window-set-title', title ?? 'Tabby')
    }

    toggleFullscreen (): void {
        this.getWindow().setFullScreen(!this._isFullscreen)
    }

    minimize (): void {
        this.electron.ipcRenderer.send('window-minimize')
    }

    isMaximized (): boolean {
        return this._isMaximized
    }

    toggleMaximize (): void {
        if (this.getWindow().isMaximized()) {
            this.getWindow().unmaximize()
        } else {
            this.getWindow().maximize()
        }
    }

    close (): void {
        this.electron.ipcRenderer.send('window-close')
    }

    hideToTray (): boolean {
        // Only Windows has a reliable tray here: Linux tray support is off and
        // macOS already keeps the app running after the window closes. With the
        // tray icon disabled there would be no way back to a hidden window.
        if (
            process.platform !== 'win32' ||
            !this.bootstrapData.isMainWindow ||
            (this.injector.get(ConfigService).store.hideTray ?? false)
        ) {
            return false
        }
        this.electron.ipcRenderer.send('window-hide-to-tray')
        return true
    }

    setBounds (bounds: Bounds): void {
        this.electron.ipcRenderer.send('window-set-bounds', bounds)
    }

    setAlwaysOnTop (flag: boolean): void {
        this.electron.ipcRenderer.send('window-set-always-on-top', flag)
    }

    setTouchBar (touchBar: TouchBar): void {
        this.getWindow().setTouchBar(touchBar)
    }

    setTrafficLightPosition (x: number, y: number): void {
        this.electron.ipcRenderer.send('window-set-traffic-light-position', x, y)
    }

    setOpacity (opacity: number): void {
        this.electron.ipcRenderer.send('window-set-opacity', opacity)
    }

    setProgressBar (value: number): void {
        this.electron.ipcRenderer.send('window-set-progress-bar', value)
    }

    bringToFront (): void {
        this.electron.ipcRenderer.send('window-bring-to-front')
    }
}
