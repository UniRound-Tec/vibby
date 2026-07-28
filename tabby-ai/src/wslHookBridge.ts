import { quoteSh } from './paths'

/**
 * File-based hook delivery for WSL sessions (the fallback lane of the WSL
 * hook bridge in claudeAdapter.service.ts).
 *
 * The durable lane uses the /mnt/c mount: writes go through the Plan 9
 * server on the Windows side and land as ordinary files. The ingress polls
 * that directory and feeds the payloads into the same translator the HTTP
 * lane uses.
 *
 * Running Windows curl.exe from inside the distro is only a fallback when
 * the file lane is unavailable. WSL's binfmt handler can exist briefly
 * during a distro cold-start and then be removed by systemd-binfmt, so a
 * successful scan-time interop probe is not durable enough to outrank
 * file delivery.
 */

/** Matches the HTTP ingress body limit */
export const DROP_FILE_LIMIT = 1024 * 1024

export interface WslHookTransportOptions {
    dropAvailable: boolean
    curlAvailable: boolean
    interop: boolean
}

export function selectWslHookTransport (
    options: WslHookTransportOptions,
): 'file'|'curl'|null {
    if (options.dropAvailable) {
        return 'file'
    }
    return options.interop && options.curlAvailable ? 'curl' : null
}

/** The final names the drop hook command produces: `<session>.<mktemp nonce>.json` */
const DROP_FILE_RE = /^([\w-]{1,64})\.[A-Za-z0-9]{6}\.json$/

/**
 * The hook command claude runs inside the distro.
 *
 * mktemp for uniqueness — hooks can fire twice in the same second and the
 * shell may be dash, so `$RANDOM` is not available. The rename at the end
 * is what makes the file visible to the poller: it only picks up `*.json`,
 * so a payload still streaming through `cat` can never be read half-written.
 */
export function wslDropHookCommand (dropDirPosix: string, sessionId: string): string {
    const template = quoteSh(`${dropDirPosix}/${sessionId}.XXXXXX`)
    return `f=$(mktemp ${template}) && cat > "$f" && mv "$f" "$f.json"`
}

/** Session a drop file belongs to, or null for anything the command did not write */
export function dropFileSessionId (name: string): string | null {
    return DROP_FILE_RE.exec(name)?.[1] ?? null
}

export interface DropFileEntry {
    name: string
    mtimeMs: number
}

/**
 * Delivery order. mktemp nonces carry no sequence, so the write time is the
 * only order there is — ties (same-millisecond hooks) fall back to the name
 * purely to keep the sort stable across polls.
 */
export function sortDropFiles<T extends DropFileEntry> (files: T[]): T[] {
    return [...files].sort((a, b) =>
        a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
}
