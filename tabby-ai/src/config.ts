import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class AiConfigProvider extends ConfigProvider {
    defaults = {
        aiCli: {
            dashboard: {
                openOnStart: true,
                reopenWhenEmpty: true,
            },
            scanner: {
                extraPaths: [],
                hidden: [],
            },
            events: {
                notifications: true,
                notifyOnIdle: false,
            },
        },
        hotkeys: {
            'toggle-dashboard': ['Ctrl-Shift-H'],
        },
    }

    platformDefaults = { }
}
