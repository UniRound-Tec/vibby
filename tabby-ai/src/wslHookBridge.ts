import { quoteSh } from './paths'

/**
 * File-based hook delivery for WSL sessions (the fallback lane of the WSL
 * hook bridge in claudeAdapter.service.ts).
 *
 * The primary lane runs the Windows curl.exe from inside the distro — a
 * Windows process connects to the Windows loopback, so neither NAT nor the
 * firewall is in the way. That trick rides WSL's binfmt interop handler,
 * and systemd distros routinely lose it (systemd-binfmt starts without
 * WSL's config and wipes the registration; stock Ubuntu-22.04 with
 * `[boot] systemd=true` ships exactly this). Without interop there is no
 * network path left either: under NAT the Windows loopback is unreachable
 * from the distro, and inbound connections to the vEthernet address are
 * dropped by the Windows firewall.
 *
 * What always works is the /mnt/c mount: writes go through the Plan 9
 * server on the Windows side and land as ordinary files. So the hook
 * command becomes "write the payload into a drop directory", and the
 * ingress polls that directory and feeds the payloads into the same
 * translator the HTTP lane uses.
 */

/** Matches the HTTP ingress body limit */
export const DROP_FILE_LIMIT = 1024 * 1024

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
