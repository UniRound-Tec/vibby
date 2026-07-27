import { ipcRenderer } from 'electron'

import {
    AI_FLOATING_CHANNELS,
    FloatingSessionSourceBridge,
} from '../../tabby-ai/src/floatingSessions'

export function installFloatingSessionSourceBridge (): void {
    const bridge: FloatingSessionSourceBridge = {
        replaceSource: snapshot => {
            ipcRenderer.send(AI_FLOATING_CHANNELS.replaceSource, snapshot)
        },
        removeSource: sourceWindowId => {
            ipcRenderer.send(AI_FLOATING_CHANNELS.removeSource, { sourceWindowId })
        },
        onFocus: callback => {
            ipcRenderer.on(AI_FLOATING_CHANNELS.focusSession, (_event, value: unknown) => {
                callback(value)
            })
        },
    }
    window.vibbyFloatingSessionSource = bridge
}
