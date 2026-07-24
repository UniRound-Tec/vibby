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
        },
    }

    platformDefaults = { }
}
