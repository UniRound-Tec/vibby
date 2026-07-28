#!/usr/bin/env node
// Run with:
//   node_modules/.bin/electron scripts/build-ai-notification-icons.mjs
//
// Converts the established CLI SVGs into notification-safe PNGs using the same
// Chromium renderer the app ships. Electron's nativeImage only guarantees
// PNG/JPEG across platforms, and Windows expects a 48px app-logo override plus
// a high-DPI representation.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as url from 'url'
import { app, BrowserWindow } from 'electron'

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
const sourceDir = path.join(root, 'tabby-ai', 'src', 'icons')
const outputDir = path.join(root, 'app', 'assets', 'notifications')
const kinds = ['claude-code', 'codex', 'opencode']

fs.mkdirSync(outputDir, { recursive: true })

app.disableHardwareAcceleration()
app.setPath('userData', path.join(os.tmpdir(), 'vibby-notification-icon-builder'))
// The builder intentionally creates one hidden window per output.
app.on('window-all-closed', () => {})

async function render (kind, size, suffix) {
    let svg = fs.readFileSync(path.join(sourceDir, `${kind}.svg`), 'utf8')
    svg = svg.replace(/currentColor/g, '#ffffff')
    const html =
        '<!doctype html><style>' +
        'html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}' +
        'body{display:flex;align-items:center;justify-content:center}' +
        '.tile{width:100%;height:100%;border-radius:22%;background:#15181d;' +
        'display:flex;align-items:center;justify-content:center}' +
        '.glyph{width:68%;height:68%}.glyph svg{width:100%;height:100%;display:block}' +
        '</style><body><div class="tile"><div class="glyph">' + svg + '</div></div></body>'
    const window = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        useContentSize: true,
        width: size,
        height: size,
        webPreferences: {
            backgroundThrottling: false,
        },
    })
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const image = (await window.webContents.capturePage()).resize({
        width: size,
        height: size,
        quality: 'best',
    })
    window.destroy()
    const output = path.join(outputDir, `${kind}${suffix}.png`)
    fs.writeFileSync(output, image.toPNG())
    console.log(`  ${path.relative(root, output)} (${size}px)`)
}

console.log('AI notification icons:')
app.whenReady().then(async () => {
    for (const kind of kinds) {
        await render(kind, 48, '')
        await render(kind, 96, '@2x')
    }
    app.quit()
}).catch(error => {
    console.error(error)
    app.exit(1)
})
