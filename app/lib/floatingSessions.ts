import { ipcMain, WebContents } from 'electron'

import {
    AI_FLOATING_CHANNELS,
    FloatingSessionSourceSnapshot,
    FloatingWindowColorScheme,
    mergeFloatingSessionSources,
    normalizeFloatingSessionSource,
} from '../../tabby-ai/src/floatingSessions'
import { FloatingSessionsWindow } from './floatingSessionsWindow'
import type { Window } from './window'

interface FocusRequest {
    sourceWindowId: number
    sessionId: string
}

interface ExpandedRequest {
    expanded: boolean
    preferredHeight: number
}

interface MoveRequest {
    deltaX: number
    deltaY: number
}

function isRecord (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function focusRequest (value: unknown): FocusRequest | null {
    if (
        !isRecord(value) ||
        !Number.isInteger(value.sourceWindowId) ||
        (value.sourceWindowId as number) <= 0 ||
        typeof value.sessionId !== 'string' ||
        !value.sessionId ||
        value.sessionId.length > 128
    ) {
        return null
    }
    return {
        sourceWindowId: value.sourceWindowId as number,
        sessionId: value.sessionId,
    }
}

function expandedRequest (value: unknown): ExpandedRequest | null {
    if (
        !isRecord(value) ||
        typeof value.expanded !== 'boolean' ||
        typeof value.preferredHeight !== 'number' ||
        !Number.isFinite(value.preferredHeight)
    ) {
        return null
    }
    return {
        expanded: value.expanded,
        preferredHeight: value.preferredHeight,
    }
}

function moveRequest (value: unknown): MoveRequest | null {
    if (
        !isRecord(value) ||
        typeof value.deltaX !== 'number' ||
        typeof value.deltaY !== 'number' ||
        !Number.isFinite(value.deltaX) ||
        !Number.isFinite(value.deltaY) ||
        Math.abs(value.deltaX) > 100 ||
        Math.abs(value.deltaY) > 100
    ) {
        return null
    }
    return {
        deltaX: Math.round(value.deltaX),
        deltaY: Math.round(value.deltaY),
    }
}

export class FloatingSessionHub {
    private sources = new Map<number, FloatingSessionSourceSnapshot>()
    private window: FloatingSessionsWindow | null = null
    private colorScheme: FloatingWindowColorScheme = 'dark'

    constructor (
        private findWindow: (windowId: number) => Window | null,
    ) {
        ipcMain.on(AI_FLOATING_CHANNELS.replaceSource, (event, value: unknown) => {
            this.replaceSource(event.sender, value)
        })
        ipcMain.on(AI_FLOATING_CHANNELS.removeSource, (event, value: unknown) => {
            if (!isRecord(value) || !Number.isInteger(value.sourceWindowId)) {
                return
            }
            const windowId = value.sourceWindowId as number
            const target = this.findWindow(windowId)
            if (target?.webContents !== event.sender) {
                return
            }
            this.removeSource(windowId)
        })
        ipcMain.on(AI_FLOATING_CHANNELS.ready, event => {
            if (this.window?.isSender(event.sender)) {
                this.publish()
            }
        })
        ipcMain.on(AI_FLOATING_CHANNELS.focusSession, (event, value: unknown) => {
            if (!this.window?.isSender(event.sender)) {
                return
            }
            const request = focusRequest(value)
            if (request) {
                this.focus(request)
            }
        })
        ipcMain.on(AI_FLOATING_CHANNELS.setExpanded, (event, value: unknown) => {
            if (!this.window?.isSender(event.sender)) {
                return
            }
            const request = expandedRequest(value)
            if (request) {
                this.window.setExpanded(request.expanded, request.preferredHeight)
            }
        })
        ipcMain.on(AI_FLOATING_CHANNELS.moveWindow, (event, value: unknown) => {
            if (!this.window?.isSender(event.sender)) {
                return
            }
            const request = moveRequest(value)
            if (request) {
                this.window.moveBy(request.deltaX, request.deltaY)
            }
        })
    }

    removeSource (windowId: number): void {
        if (this.sources.delete(windowId)) {
            this.publish()
        }
    }

    destroy (): void {
        this.sources.clear()
        this.window?.destroy()
        this.window = null
    }

    private replaceSource (sender: WebContents, value: unknown): void {
        const source = normalizeFloatingSessionSource(value)
        if (!source) {
            return
        }
        const target = this.findWindow(source.sourceWindowId)
        if (target?.webContents !== sender) {
            return
        }
        this.sources.set(source.sourceWindowId, source)
        if (source.enabled) {
            this.colorScheme = source.colorScheme
        }
        this.publish()
    }

    private publish (): void {
        const activeSources = [...this.sources.values()].filter(source => source.enabled)
        if (!activeSources.length) {
            this.window?.destroy()
            this.window = null
            return
        }
        const sessions = mergeFloatingSessionSources(activeSources)
        if (!sessions.length) {
            this.window?.sendSnapshot({ colorScheme: this.colorScheme, sessions: [] })
            this.window?.hide()
            return
        }
        this.ensureWindow()
        this.window?.sendSnapshot({ colorScheme: this.colorScheme, sessions })
        this.window?.show()
    }

    private ensureWindow (): void {
        if (this.window) {
            return
        }
        this.window = new FloatingSessionsWindow(
            () => this.publish(),
            () => {
                this.window = null
            },
        )
    }

    private focus (request: FocusRequest): void {
        const sessions = mergeFloatingSessionSources(
            [...this.sources.values()].filter(source => source.enabled),
        )
        const session = sessions.find(item =>
            item.sessionId === request.sessionId &&
            item.sourceWindowId === request.sourceWindowId,
        )
        if (!session) {
            return
        }
        const target = this.findWindow(session.sourceWindowId)
        if (!target || target.isDestroyed()) {
            this.removeSource(session.sourceWindowId)
            return
        }
        void target.restoreAndPresent()
        target.send(AI_FLOATING_CHANNELS.focusSession, { sessionId: session.sessionId })
    }
}
