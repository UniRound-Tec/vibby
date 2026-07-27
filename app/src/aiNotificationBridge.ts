import { ipcRenderer } from 'electron'

import {
    AI_NOTIFICATION_CHANNELS,
    AiNotificationBridge,
} from '../../tabby-ai/src/notifications'

export function installAiNotificationBridge (): void {
    const bridge: AiNotificationBridge = {
        notify: request => {
            ipcRenderer.send(AI_NOTIFICATION_CHANNELS.notify, request)
        },
        onActivated: callback => {
            ipcRenderer.on(AI_NOTIFICATION_CHANNELS.activated, (_event, value: unknown) => {
                callback(value)
            })
        },
    }
    window.vibbyAiNotifications = bridge
}
