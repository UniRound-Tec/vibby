// Dev-only: talk to the running `npm start -- --remote-debugging-port=9222`
// instance. Used to verify UI changes by reading the real DOM and taking real
// screenshots instead of guessing. Not part of any build.
//
//   node scripts/cdp.mjs eval "<expression>"
//   node scripts/cdp.mjs shot <file.png>
import fs from 'fs/promises'
import WebSocket from 'ws'

const PORT = process.env.CDP_PORT ?? 9222

async function target () {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find(x => x.type === 'page' && x.url.includes('index.html'))
    if (!page) {
        throw new Error('no tabby window found on the debugging port')
    }
    return page.webSocketDebuggerUrl
}

async function session () {
    const ws = new WebSocket(await target(), { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
    })
    let id = 0
    const pending = new Map()
    ws.on('message', data => {
        const message = JSON.parse(data.toString())
        const resolver = pending.get(message.id)
        if (resolver) {
            pending.delete(message.id)
            resolver(message)
        }
    })
    return {
        send: (method, params = {}) => new Promise(resolve => {
            const messageId = ++id
            pending.set(messageId, resolve)
            ws.send(JSON.stringify({ id: messageId, method, params }))
        }),
        close: () => ws.close(),
    }
}

const [command, ...rest] = process.argv.slice(2)
const cdp = await session()

if (command === 'eval') {
    const result = await cdp.send('Runtime.evaluate', {
        expression: rest.join(' '),
        awaitPromise: true,
        returnByValue: true,
    })
    const value = result.result?.result
    console.log(value?.type === 'string' ? value.value : JSON.stringify(value?.value ?? result.result, null, 2))
} else if (command === 'shot') {
    // shot <file.png> [x y w h] [scale] — optional clip is in CSS px
    const [file, x, y, w, h, scale] = rest
    const params = { format: 'png' }
    if (x !== undefined) {
        params.clip = { x: +x, y: +y, width: +w, height: +h, scale: +(scale ?? 1) }
    }
    const result = await cdp.send('Page.captureScreenshot', params)
    await fs.writeFile(file, Buffer.from(result.result.data, 'base64'))
    console.log(`wrote ${file}`)
} else if (command === 'hover') {
    // synthetic, at the CDP layer — it never touches the real cursor
    const [x, y] = rest.map(Number)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
    console.log(`hovered ${x},${y}`)
} else if (command === 'click') {
    // same — CDP-level synthetic click
    const [x, y] = rest.map(Number)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    console.log(`clicked ${x},${y}`)
} else {
    console.error('usage: cdp.mjs eval <expr> | shot <file.png> | hover <x> <y> | click <x> <y>')
    process.exitCode = 1
}

cdp.close()
