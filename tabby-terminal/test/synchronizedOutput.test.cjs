const assert = require('node:assert/strict')

const {
    CursorShowDebouncer,
    SynchronizedOutputBuffer,
} = require('../.test-build/synchronizedOutput.js')

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'

{
    const buffer = new SynchronizedOutputBuffer()

    assert.deepEqual(buffer.push('plain output'), ['plain output'])
    assert.equal(buffer.pending, false)
}

{
    const buffer = new SynchronizedOutputBuffer()

    assert.deepEqual(buffer.push(`before${SYNC_START.slice(0, 5)}`), ['before'])
    assert.equal(buffer.pending, true)
    assert.deepEqual(buffer.push(`${SYNC_START.slice(5)}frame one`), [])
    assert.deepEqual(buffer.push(` + frame two${SYNC_END.slice(0, 6)}`), [])
    assert.deepEqual(buffer.push(`${SYNC_END.slice(6)}after`), [
        'frame one + frame two',
        'after',
    ])
    assert.equal(buffer.pending, false)
}

{
    const buffer = new SynchronizedOutputBuffer()

    assert.deepEqual(buffer.push(
        `a${SYNC_START}first${SYNC_END}b${SYNC_START}second${SYNC_END}c`,
    ), ['a', 'first', 'b', 'second', 'c'])
}

{
    const buffer = new SynchronizedOutputBuffer()

    assert.deepEqual(buffer.push(`${SYNC_START}unfinished`), [])
    assert.deepEqual(buffer.flush(), ['unfinished'])
    assert.equal(buffer.pending, false)
}

{
    const buffer = new SynchronizedOutputBuffer(8)

    assert.deepEqual(buffer.push(`${SYNC_START}123456789`), ['123456789'])
    assert.equal(buffer.pending, false)
    assert.deepEqual(buffer.push('still live'), ['still live'])
}

{
    const cursor = new CursorShowDebouncer()

    assert.deepEqual(cursor.push(`${CURSOR_HIDE}\x1b[12;8H${CURSOR_SHOW}`), [
        `${CURSOR_HIDE}\x1b[12;8H`,
    ])
    assert.equal(cursor.pending, true)

    assert.deepEqual(cursor.push(`${CURSOR_HIDE}\x1b[12;9H${CURSOR_SHOW}`), [
        `${CURSOR_HIDE}\x1b[12;9H`,
    ])
    assert.equal(cursor.pending, true)

    assert.deepEqual(cursor.release(), [CURSOR_SHOW])
    assert.equal(cursor.pending, false)
}

{
    const cursor = new CursorShowDebouncer()

    assert.deepEqual(cursor.push(`${CURSOR_SHOW.slice(0, 4)}`), [])
    assert.deepEqual(cursor.push(`${CURSOR_SHOW.slice(4)}text${CURSOR_HIDE}`), [
        `text${CURSOR_HIDE}`,
    ])
    assert.equal(cursor.pending, false)
    assert.deepEqual(cursor.release(), [])
}

console.log('synchronized output buffer tests passed')
