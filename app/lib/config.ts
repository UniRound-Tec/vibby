import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { writeFile } from 'atomically'


export const configPath = path.join(process.env.TABBY_CONFIG_DIRECTORY!, 'config.yaml')

/**
 * Earlier identities of this app, newest first. Copy-once only: a config
 * that exists here is never overwritten, so a Vibby config that has since
 * diverged from the old Tabby one cannot be clobbered by a leftover
 * installation (the old mtime-wins rule did exactly that).
 */
const legacyConfigPaths = [
    path.join(process.env.TABBY_CONFIG_DIRECTORY!, '../tabby', 'config.yaml'),
    path.join(process.env.TABBY_CONFIG_DIRECTORY!, '../terminus', 'config.yaml'),
]

export function migrateConfig (): void {
    if (fs.existsSync(configPath)) {
        return
    }
    for (const legacyPath of legacyConfigPaths) {
        if (fs.existsSync(legacyPath)) {
            // first launch under the new identity — the directory may not exist yet
            fs.mkdirSync(path.dirname(configPath), { recursive: true })
            fs.writeFileSync(configPath, fs.readFileSync(legacyPath))
            return
        }
    }
}

export function loadConfig (): any {
    migrateConfig()

    if (fs.existsSync(configPath)) {
        return yaml.load(fs.readFileSync(configPath, 'utf8'))
    } else {
        return {}
    }
}

export async function saveConfig (content: string): Promise<void> {
    await writeFile(configPath, content, { encoding: 'utf8' })
    await writeFile(configPath + '.backup', content, { encoding: 'utf8' })
}
