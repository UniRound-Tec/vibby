const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'
const DEFAULT_MAX_BUFFERED_LENGTH = 1024 * 1024

function suffixPrefixLength (value: string, marker: string): number {
    const maxLength = Math.min(value.length, marker.length - 1)
    for (let length = maxLength; length > 0; length--) {
        if (value.endsWith(marker.slice(0, length))) {
            return length
        }
    }
    return 0
}

/**
 * Coalesces DEC private mode 2026 frames into one xterm write.
 *
 * xterm.js 5.x ignores the synchronized-output mode, so allowing a frame
 * through piecemeal exposes cursor positions from intermediate TUI redraws.
 */
export class SynchronizedOutputBuffer {
    private carry = ''
    private frame = ''
    private synchronizing = false

    constructor (
        private maxBufferedLength = DEFAULT_MAX_BUFFERED_LENGTH,
    ) { }

    get pending (): boolean {
        return this.synchronizing || !!this.carry
    }

    push (data: string): string[] {
        let input = this.carry + data
        this.carry = ''
        const output: string[] = []

        while (input) {
            const marker = this.synchronizing ? SYNC_END : SYNC_START
            const markerIndex = input.indexOf(marker)

            if (markerIndex !== -1) {
                const preceding = input.slice(0, markerIndex)
                if (this.synchronizing) {
                    this.frame += preceding
                    if (this.frame) {
                        output.push(this.frame)
                    }
                    this.frame = ''
                    this.synchronizing = false
                } else {
                    if (preceding) {
                        output.push(preceding)
                    }
                    this.synchronizing = true
                }
                input = input.slice(markerIndex + marker.length)
                continue
            }

            const partialLength = suffixPrefixLength(input, marker)
            const complete = input.slice(0, input.length - partialLength)
            const partial = input.slice(input.length - partialLength)

            if (this.synchronizing) {
                if (this.frame.length + complete.length + partial.length > this.maxBufferedLength) {
                    output.push(this.frame + complete + partial)
                    this.frame = ''
                    this.synchronizing = false
                } else {
                    this.frame += complete
                    this.carry = partial
                }
            } else {
                if (complete) {
                    output.push(complete)
                }
                this.carry = partial
            }
            break
        }

        return output
    }

    flush (): string[] {
        const pending = this.frame + this.carry
        this.frame = ''
        this.carry = ''
        this.synchronizing = false
        return pending ? [pending] : []
    }
}

export class CursorShowDebouncer {
    private carry = ''
    private showPending = false
    private visibilityRevision = 0

    get pending (): boolean {
        return this.showPending
    }

    get revision (): number {
        return this.visibilityRevision
    }

    push (data: string): string[] {
        let input = this.carry + data
        this.carry = ''
        let output = ''

        while (input) {
            const showIndex = input.indexOf(CURSOR_SHOW)
            const hideIndex = input.indexOf(CURSOR_HIDE)
            const markerIndex = showIndex === -1
                ? hideIndex
                : hideIndex === -1
                    ? showIndex
                    : Math.min(showIndex, hideIndex)

            if (markerIndex !== -1) {
                output += input.slice(0, markerIndex)
                const isShow = markerIndex === showIndex
                if (isShow) {
                    this.showPending = true
                } else {
                    this.showPending = false
                    output += CURSOR_HIDE
                }
                this.visibilityRevision++
                input = input.slice(markerIndex + (isShow ? CURSOR_SHOW.length : CURSOR_HIDE.length))
                continue
            }

            const partialLength = Math.max(
                suffixPrefixLength(input, CURSOR_SHOW),
                suffixPrefixLength(input, CURSOR_HIDE),
            )
            output += input.slice(0, input.length - partialLength)
            this.carry = input.slice(input.length - partialLength)
            break
        }

        return output ? [output] : []
    }

    release (): string[] {
        if (!this.showPending) {
            return []
        }
        this.showPending = false
        return [CURSOR_SHOW]
    }
}
