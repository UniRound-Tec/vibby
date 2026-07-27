import { app, BrowserWindow, Rectangle, screen, WebContents } from 'electron'
import ElectronConfig = require('electron-config')
import * as path from 'path'

import {
    AI_FLOATING_CHANNELS,
    FloatingSessionWindowSnapshot,
} from '../../tabby-ai/src/floatingSessions'

const WINDOW_WIDTH = 352
const COLLAPSED_HEIGHT = 202
const MIN_HEIGHT = 82
const WORK_AREA_HEIGHT_RATIO = 0.7
const SCREEN_MARGIN = 20
const MAX_RELOAD_ATTEMPTS = 5

interface StoredPosition {
    x: number
    y: number
}

function isStoredPosition (value: unknown): value is StoredPosition {
    if (!value || typeof value !== 'object') {
        return false
    }
    const position = value as Partial<StoredPosition>
    return Number.isFinite(position.x) && Number.isFinite(position.y)
}

export class FloatingSessionsWindow {
    private window: BrowserWindow | null
    private ready = false
    private destroying = false
    private positionConfig = new ElectronConfig({ name: 'floating-sessions-window' })
    private savePositionTimeout: ReturnType<typeof setTimeout> | null = null
    /**
     * The size we asked for, kept here rather than read back from the window.
     * Under a fractional display scale Chromium reports bounds through
     * ScaleToEnclosingRect, so getBounds() rounds the size outwards by up to a
     * pixel depending on where the window currently sits. Feeding that back
     * into setBounds()/setPosition() grows the window on every drag event.
     */
    private width: number
    private height: number
    private reloadAttempts = 0
    private reloadTimeout: ReturnType<typeof setTimeout> | null = null
    /**
     * Bound once so the app-global screen emitter can be unsubscribed when
     * this window closes — a plain method reference would never match.
     */
    private handleDisplayChange = (): void => this.ensureOnScreen()

    constructor (
        private onReady: () => void,
        private onClosed: () => void,
    ) {
        const bounds = this.initialBounds()
        this.width = bounds.width
        this.height = bounds.height
        this.window = new BrowserWindow({
            ...bounds,
            title: 'Vibby',
            useContentSize: true,
            frame: false,
            transparent: true,
            resizable: false,
            maximizable: false,
            minimizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            show: false,
            hasShadow: false,
            backgroundColor: '#00000000',
            webPreferences: {
                preload: path.join(app.getAppPath(), 'dist', 'floating-sessions-preload.js'),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                backgroundThrottling: false,
            },
        })

        this.window.setMenu(null)
        this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        this.window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

        // `on`, not `once`: after a crash recovery reload, onReady must fire
        // again so the hub re-sends the snapshot into the fresh renderer.
        this.window.webContents.on('did-finish-load', () => {
            this.ready = true
            this.reloadAttempts = 0
            this.onReady()
        })

        // A dead renderer leaves a transparent frameless window fully blank
        // while isVisible() still says true — to the user it just vanishes,
        // and nothing would ever repaint it. Reload instead of waiting.
        this.window.webContents.on('render-process-gone', (_event, details) => {
            this.recoverContent(`renderer gone (${details.reason})`)
        })
        this.window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
            if (!isMainFrame || errorCode === -3) { // -3 is ERR_ABORTED: a newer load superseded this one
                return
            }
            this.recoverContent(`load failed (${errorCode} ${errorDescription})`)
        })

        this.window.on('move', () => this.schedulePositionSave())
        this.window.on('close', event => {
            if (!this.destroying) {
                event.preventDefault()
                this.window?.hide()
            }
        })
        this.window.on('closed', () => {
            screen.removeListener('display-metrics-changed', this.handleDisplayChange)
            screen.removeListener('display-removed', this.handleDisplayChange)
            if (this.reloadTimeout) {
                clearTimeout(this.reloadTimeout)
                this.reloadTimeout = null
            }
            this.window = null
            this.onClosed()
        })

        // Unplugging a monitor or changing its resolution/scale can leave the
        // window stranded in an area no display covers anymore.
        screen.on('display-metrics-changed', this.handleDisplayChange)
        screen.on('display-removed', this.handleDisplayChange)

        this.loadContent()
    }

    get webContents (): WebContents | null {
        return this.window?.webContents ?? null
    }

    isSender (sender: WebContents): boolean {
        return sender === this.window?.webContents
    }

    sendSnapshot (snapshot: FloatingSessionWindowSnapshot): void {
        if (!this.ready || !this.window || this.window.isDestroyed()) {
            return
        }
        this.window.webContents.send(AI_FLOATING_CHANNELS.snapshot, snapshot)
    }

    show (): void {
        if (!this.ready || !this.window || this.window.isDestroyed() || this.window.isVisible()) {
            return
        }
        this.window.showInactive()
    }

    hide (): void {
        this.window?.hide()
    }

    setExpanded (_expanded: boolean, preferredHeight: number): void {
        if (!this.window || this.window.isDestroyed() || !Number.isFinite(preferredHeight)) {
            return
        }
        const [x, y] = this.window.getPosition()
        const display = screen.getDisplayNearestPoint({
            x: x + Math.round(this.width / 2),
            y: y + Math.round(this.height / 2),
        })
        const maxHeight = Math.floor(display.workArea.height * WORK_AREA_HEIGHT_RATIO)
        const height = Math.max(MIN_HEIGHT, Math.min(Math.round(preferredHeight), maxHeight))
        this.applyBounds(this.clampToWorkArea(
            { x, y, width: this.width, height },
            display.workArea,
        ))
    }

    /**
     * Absolute, because a fractional display scale leaves some coordinates
     * unreachable — at 1.5x every odd one snaps back to the even one below.
     * Reading the position back to add a delta to it therefore swallows the
     * remainder on every event, and a slow drag never moves the window at all.
     */
    moveTo (x: number, y: number): void {
        if (!this.window || this.window.isDestroyed()) {
            return
        }
        // setPosition() would resize to getSize(), which is the outward-rounded
        // reading — carry our own size across instead. Clamped like every other
        // placement path: the drag handle is the only way to grab the window,
        // so letting a drag push it past the work area loses it for good.
        const proposed: Rectangle = { x, y, width: this.width, height: this.height }
        const display = screen.getDisplayNearestPoint({
            x: x + Math.round(this.width / 2),
            y: y + Math.round(this.height / 2),
        })
        this.applyBounds(this.clampToWorkArea(proposed, display.workArea))
    }

    destroy (): void {
        if (!this.window || this.window.isDestroyed()) {
            return
        }
        this.destroying = true
        if (this.savePositionTimeout) {
            clearTimeout(this.savePositionTimeout)
            this.savePositionTimeout = null
        }
        this.savePosition()
        this.window.destroy()
    }

    private loadContent (): void {
        this.window?.loadFile(path.join(app.getAppPath(), 'dist', 'floating-sessions.html'))
    }

    private recoverContent (cause: string): void {
        if (!this.window || this.window.isDestroyed() || this.destroying || this.reloadTimeout) {
            return
        }
        this.ready = false
        if (this.reloadAttempts >= MAX_RELOAD_ATTEMPTS) {
            console.error(`Floating sessions window gave up reloading after ${cause}`)
            return
        }
        this.reloadAttempts++
        console.warn(`Floating sessions window reloading (attempt ${this.reloadAttempts}) after ${cause}`)
        this.reloadTimeout = setTimeout(() => {
            this.reloadTimeout = null
            this.loadContent()
        }, 1000 * this.reloadAttempts)
    }

    /** Pull the window back into whichever display is now nearest to it. */
    private ensureOnScreen (): void {
        if (!this.window || this.window.isDestroyed()) {
            return
        }
        const [x, y] = this.window.getPosition()
        const proposed: Rectangle = { x, y, width: this.width, height: this.height }
        const display = screen.getDisplayNearestPoint({
            x: x + Math.round(this.width / 2),
            y: y + Math.round(this.height / 2),
        })
        const clamped = this.clampToWorkArea(proposed, display.workArea)
        if (clamped.x !== x || clamped.y !== y) {
            this.applyBounds(clamped)
        }
    }

    /** The one place a size reaches the window, so `width`/`height` stay true. */
    private applyBounds (bounds: Rectangle): void {
        this.width = bounds.width
        this.height = bounds.height
        this.window?.setBounds(bounds)
    }

    private initialBounds (): Rectangle {
        const display = screen.getPrimaryDisplay()
        const stored = this.positionConfig.get('position')
        const proposed: Rectangle = {
            x: isStoredPosition(stored)
                ? stored.x
                : display.workArea.x + display.workArea.width - WINDOW_WIDTH - SCREEN_MARGIN,
            y: isStoredPosition(stored)
                ? stored.y
                : display.workArea.y + SCREEN_MARGIN,
            width: WINDOW_WIDTH,
            height: COLLAPSED_HEIGHT,
        }
        const nearest = screen.getDisplayNearestPoint({ x: proposed.x, y: proposed.y })
        return this.clampToWorkArea(proposed, nearest.workArea)
    }

    private clampToWorkArea (bounds: Rectangle, workArea: Rectangle): Rectangle {
        const width = Math.min(bounds.width, workArea.width)
        const height = Math.min(bounds.height, workArea.height)
        return {
            x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)),
            y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
            width,
            height,
        }
    }

    private schedulePositionSave (): void {
        if (this.savePositionTimeout) {
            clearTimeout(this.savePositionTimeout)
        }
        this.savePositionTimeout = setTimeout(() => {
            this.savePositionTimeout = null
            this.savePosition()
        }, 250)
    }

    private savePosition (): void {
        if (!this.window || this.window.isDestroyed()) {
            return
        }
        const { x, y } = this.window.getBounds()
        this.positionConfig.set('position', { x, y })
    }
}
