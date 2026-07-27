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
                wsl: {
                    enabled: true,
                    excludedDistributions: [
                        'docker-desktop',
                        'docker-desktop-data',
                    ],
                },
            },
            events: {
                notifications: true,
                /** A finished turn is the moment you are wanted back */
                notifyOnIdle: true,
            },
            rail: {
                /** Side tab bar narrowed to icons only. Ignored on horizontal bars. */
                collapsed: false,
            },
            floatingWindow: {
                enabled: false,
            },
            codex: {
                /** Set once the hook-trust-bypass notice is dismissed for good */
                trustBypassAcknowledged: false,
            },
        },
        hotkeys: {
            'toggle-dashboard': ['Ctrl-Shift-H'],
        },
    }

    platformDefaults = { }
}
