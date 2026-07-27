import type {
    FloatingSessionWindowSnapshot,
} from '../../tabby-ai/src/floatingSessions'

export interface FloatingSessionsBridge {
    onSnapshot: (callback: (snapshot: FloatingSessionWindowSnapshot) => void) => void
    focusSession: (sourceWindowId: number, sessionId: string) => void
    setExpanded: (expanded: boolean, preferredHeight: number) => void
    /** Absolute screen position for the window origin, not a delta. */
    moveWindow: (x: number, y: number) => void
    ready: () => void
}

declare global {
    interface Window {
        floatingSessions: FloatingSessionsBridge
    }
}
