import * as nodePTY from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import { WebContents, ipcMain } from 'electron'
import { Application } from './app'
import { UTF8Splitter } from './utfSplitter'
import { Subject, Subscription, debounceTime } from 'rxjs'

class PTYDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private maxChunk = 1024 * 100
    private maxDelta = this.maxChunk * 5
    private flowPaused = false
    private decoder = new UTF8Splitter()
    private output$ = new Subject<Buffer>()
    private flushSubscription: Subscription

    constructor (private pty: nodePTY.IPty, private onData: (data: Buffer) => void) {
        this.flushSubscription = this.output$.pipe(debounceTime(500)).subscribe(() => {
            const remainder = this.decoder.flush()
            if (remainder.length) {
                this.onData(remainder)
            }
        })
    }

    dispose (): void {
        this.flushSubscription.unsubscribe()
        this.output$.complete()
    }

    isEmpty (): boolean {
        return this.buffers.length === 0
    }

    push (data: Buffer) {
        this.buffers.push(data)
        this.maybeEmit()
    }

    ack (length: number) {
        this.delta -= length
        this.maybeEmit()
    }

    private maybeEmit () {
        if (this.delta <= this.maxDelta && this.flowPaused) {
            this.resume()
            return
        }
        if (this.buffers.length > 0) {
            if (this.delta > this.maxDelta && !this.flowPaused) {
                this.pause()
                return
            }

            const buffersToSend = []
            let totalLength = 0
            while (totalLength < this.maxChunk && this.buffers.length) {
                totalLength += this.buffers[0].length
                buffersToSend.push(this.buffers.shift())
            }

            if (buffersToSend.length === 0) {
                return
            }

            let toSend = Buffer.concat(buffersToSend)
            if (toSend.length > this.maxChunk) {
                this.buffers.unshift(toSend.slice(this.maxChunk))
                toSend = toSend.slice(0, this.maxChunk)
            }
            this.emitData(toSend)
            this.delta += toSend.length

            if (this.buffers.length) {
                setImmediate(() => this.maybeEmit())
            }
        }
    }

    private emitData (data: Buffer) {
        const validChunk = this.decoder.write(data)
        this.onData(validChunk)
        this.output$.next(validChunk)
    }

    private pause () {
        this.pty.pause()
        this.flowPaused = true
    }

    private resume () {
        this.pty.resume()
        this.flowPaused = false
        this.maybeEmit()
    }
}

export class PTY {
    private pty: nodePTY.IPty
    private outputQueue: PTYDataQueue
    private released = false
    exited = false

    constructor (
        private id: string,
        private sender: WebContents,
        private onReleased: (id: string) => void,
        ...args: any[]
    ) {
        this.pty = (nodePTY as any).spawn(...args)
        for (const key of ['close', 'exit']) {
            (this.pty as any).on(key, (...eventArgs) => this.emit(key, ...eventArgs))
        }

        this.outputQueue = new PTYDataQueue(this.pty, data => {
            setImmediate(() => this.emit('data', data))
        })

        this.pty.onData(data => this.outputQueue.push(Buffer.from(data)))
        this.pty.onExit(() => {
            this.exited = true
            // `close` normally follows and releases immediately; the timer
            // covers platforms where it never arrives. Long enough for the
            // queue's debounced UTF-8 remainder flush to have gone out.
            setTimeout(() => this.release(), 5000)
        })
        ;(this.pty as any).on('close', () => this.release())
    }

    /** A reloaded renderer reattaches to a live PTY — data must follow it */
    takeOwnership (sender: WebContents): void {
        this.sender = sender
    }

    getPID (): number {
        return this.pty.pid
    }

    resize (columns: number, rows: number): void {
        if ((this.pty as any)._writable) {
            this.pty.resize(columns, rows)
        }
    }

    write (buffer: Buffer): void {
        if ((this.pty as any)._writable) {
            this.pty.write(buffer as any)
        }
    }

    ackData (length: number): void {
        this.outputQueue.ack(length)
    }

    kill (signal?: string): void {
        this.pty.kill(signal)
    }

    private emit (event: string, ...args: any[]) {
        if (!this.sender.isDestroyed()) {
            this.sender.send(`pty:${this.id}:${event}`, ...args)
        }
    }

    private release (attempt = 0): void {
        if (this.released) {
            return
        }
        // data still queued behind flow control is being acked down by the
        // renderer — don't cut it off; but a dead renderer can't pin us forever
        if (!this.outputQueue.isEmpty() && attempt < 30 && !this.sender.isDestroyed()) {
            setTimeout(() => this.release(attempt + 1), 1000)
            return
        }
        this.released = true
        this.outputQueue.dispose()
        this.onReleased(this.id)
    }
}

export class PTYManager {
    private ptys = new Map<string, PTY>()

    init (_app: Application): void {
        ipcMain.on('pty:spawn', (event, ...options) => {
            const id = uuidv4().toString()
            event.returnValue = id
            this.ptys.set(id, new PTY(id, event.sender, released => {
                this.ptys.delete(released)
            }, ...options))
        })

        ipcMain.on('pty:exists', (event, id) => {
            const pty = this.ptys.get(id)
            // the recovery handshake — whoever asks is about to attach,
            // so route subsequent data to them
            pty?.takeOwnership(event.sender)
            event.returnValue = !!pty && !pty.exited
        })

        ipcMain.on('pty:get-pid', (event, id) => {
            event.returnValue = this.ptys.get(id)?.getPID()
        })

        ipcMain.on('pty:resize', (_event, id, columns, rows) => {
            this.ptys.get(id)?.resize(columns, rows)
        })

        ipcMain.on('pty:write', (_event, id, data) => {
            this.ptys.get(id)?.write(Buffer.from(data))
        })

        ipcMain.on('pty:kill', (_event, id, signal) => {
            this.ptys.get(id)?.kill(signal)
        })

        ipcMain.on('pty:ack-data', (_event, id, length) => {
            this.ptys.get(id)?.ackData(length)
        })
    }
}
