import type {
    FloatingSessionWindowSnapshot,
} from '../../tabby-ai/src/floatingSessions'

export interface FloatingSessionsBridge {
    onSnapshot: (callback: (snapshot: FloatingSessionWindowSnapshot) => void) => void
    focusSession: (sourceWindowId: number, sessionId: string) => void
    setExpanded: (expanded: boolean, preferredHeight: number) => void
    moveWindow: (deltaX: number, deltaY: number) => void
    ready: () => void
}

declare global {
    interface Window {
        floatingSessions: FloatingSessionsBridge
    }
}
