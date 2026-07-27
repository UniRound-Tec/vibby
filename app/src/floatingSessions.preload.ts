import { contextBridge, ipcRenderer } from 'electron'

import {
    AI_FLOATING_CHANNELS,
    FloatingSessionWindowSnapshot,
} from '../../tabby-ai/src/floatingSessions'
import { FloatingSessionsBridge } from './floatingSessions.api'

const bridge: FloatingSessionsBridge = {
    onSnapshot: callback => {
        ipcRenderer.on(AI_FLOATING_CHANNELS.snapshot, (_event, snapshot: FloatingSessionWindowSnapshot) => {
            callback(snapshot)
        })
    },
    focusSession: (sourceWindowId, sessionId) => {
        ipcRenderer.send(AI_FLOATING_CHANNELS.focusSession, { sourceWindowId, sessionId })
    },
    setExpanded: (expanded, preferredHeight) => {
        ipcRenderer.send(AI_FLOATING_CHANNELS.setExpanded, { expanded, preferredHeight })
    },
    moveWindow: (x, y) => {
        ipcRenderer.send(AI_FLOATING_CHANNELS.moveWindow, { x, y })
    },
    ready: () => {
        ipcRenderer.send(AI_FLOATING_CHANNELS.ready)
    },
}

contextBridge.exposeInMainWorld('floatingSessions', bridge)
