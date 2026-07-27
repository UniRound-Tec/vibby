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

    constructor (
        private onReady: () => void,
        private onClosed: () => void,
    ) {
        const bounds = this.initialBounds()
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

        this.window.webContents.once('did-finish-load', () => {
            this.ready = true
            this.onReady()
        })

        this.window.on('move', () => this.schedulePositionSave())
        this.window.on('close', event => {
            if (!this.destroying) {
                event.preventDefault()
                this.window?.hide()
            }
        })
        this.window.on('closed', () => {
            this.window = null
            this.onClosed()
        })

        this.window.loadFile(path.join(app.getAppPath(), 'dist', 'floating-sessions.html'))
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
        const current = this.window.getBounds()
        const display = screen.getDisplayNearestPoint({
            x: current.x + Math.round(current.width / 2),
            y: current.y + Math.round(current.height / 2),
        })
        const maxHeight = Math.floor(display.workArea.height * WORK_AREA_HEIGHT_RATIO)
        const height = Math.max(MIN_HEIGHT, Math.min(Math.round(preferredHeight), maxHeight))
        const bounds = this.clampToWorkArea({ ...current, height }, display.workArea)
        this.window.setBounds(bounds)
    }

    moveBy (deltaX: number, deltaY: number): void {
        if (!this.window || this.window.isDestroyed() || !deltaX && !deltaY) {
            return
        }
        const [x, y] = this.window.getPosition()
        this.window.setPosition(x + deltaX, y + deltaY)
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
