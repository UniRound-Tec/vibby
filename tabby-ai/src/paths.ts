import * as path from 'path'

/**
 * Naming for everything vibby writes into the system temp directory.
 *
 * The hook settings file and the per-terminal command shims both live under
 * one per-process directory created with `fs.mkdtempSync`, which gives it
 * 0700 and a random suffix. Both matter on POSIX: `os.tmpdir()` is the shared
 * `/tmp` there, so a fixed name could be pre-created by another local user,
 * who would then own the directory our shims are written into — and those
 * shims go on the session's PATH.
 */
export const HOOK_DIR_PREFIX = 'vibby-hooks'

/** Per-session shim directory, created inside the hook directory */
export const SHIM_DIR_PREFIX = 'vibby-cli-'

/**
 * Subdirectory of the hook directory where WSL sessions whose distro cannot
 * execute Windows binaries drop their hook payloads as files (see
 * wslHookBridge.ts). Lives inside the mkdtemp directory so it shares its
 * 0700 mode and its stale-directory sweep.
 */
export const DROP_DIR_NAME = 'drop'

/**
 * Matches a hook directory, this process's or a leftover from an earlier run.
 *
 * Deliberately keyed on the exact shape mkdtemp produces — the prefix plus its
 * six random characters — rather than on the prefix alone. cleanupStaleFiles()
 * deletes matches recursively out of a shared /tmp, so `vibby-hooks-notes` had
 * better not look like ours.
 */
const HOOK_DIR_RE = new RegExp(`^${HOOK_DIR_PREFIX}-[A-Za-z0-9]{6}$`)

export function isHookDirName (name: string): boolean {
    return HOOK_DIR_RE.test(name)
}

/**
 * The fixed name used before mkdtemp. Builds that used it left their settings
 * files — each holding an ingress token, and world-readable on POSIX — behind
 * with nothing to collect them, so the sweep takes this one too.
 *
 * Safe only in combination with holdsOnlyGeneratedFiles(): on POSIX this is
 * exactly the name another local user could have created, which is what moving
 * to mkdtemp was about. The contents decide, not the name.
 */
export function isLegacyHookDirName (name: string): boolean {
    return name === HOOK_DIR_PREFIX
}

/**
 * Whether a directory's contents are all things we wrote. The name check alone
 * cannot rule out a collision, and the sweep is a recursive delete, so the
 * contents get a say before anything is removed.
 */
export function holdsOnlyGeneratedFiles (entries: string[]): boolean {
    return entries.every(entry =>
        entry.endsWith('.json') || entry.startsWith(SHIM_DIR_PREFIX) || entry === DROP_DIR_NAME,
    )
}

const SETTINGS_PID_RE = /^(\d+)-/
const SHIM_PID_RE = new RegExp(`^${SHIM_DIR_PREFIX}(\\d+)-`)

/**
 * Process ids embedded in a hook directory's entries. Settings files are named
 * `<pid>-<session>.json` and shim directories `vibby-cli-<pid>-<session>`, so
 * the directory itself records who wrote it. The sweep uses this to spare
 * directories whose owner is still running — a vibby instance can easily
 * outlive the 24h mtime cutoff.
 */
export function ownerPids (entries: string[]): number[] {
    const pids = new Set<number>()
    for (const entry of entries) {
        const match = SHIM_PID_RE.exec(entry) ?? SETTINGS_PID_RE.exec(entry)
        if (match) {
            pids.add(Number(match[1]))
        }
    }
    return [...pids]
}

/**
 * True for a path we generated — used to drop stale shim directories out of
 * `pathPrefix` before prepending a fresh one, so a recovered profile cannot
 * accumulate pointers to temp directories that no longer exist.
 */
export function isGeneratedPath (value: string): boolean {
    return isHookDirName(path.basename(path.dirname(value))) ||
        path.basename(value).startsWith(SHIM_DIR_PREFIX)
}

/** PID encoded in a generated shim directory, or null for anything else. */
export function generatedPathOwnerPid (value: string): number|null {
    const match = SHIM_PID_RE.exec(path.basename(value))
    return match ? Number(match[1]) : null
}

/**
 * Quote a value for a generated .cmd wrapper.
 *
 * Two parsers read this line and they disagree. cmd expands `%VAR%` when it
 * runs the batch file, so a percent sign has to be doubled or it arrives
 * mangled — or, for an undefined name, silently empty. The program cmd then
 * launches re-splits the same text under CommandLineToArgvW rules, where a
 * backslash escapes a following quote.
 *
 * So a literal quote is written `""`, which keeps cmd inside its own quoted
 * state (any `|` or `&` in the value stays inert) while still reaching the
 * callee as one quote — and every backslash that lands directly in front of a
 * quote is doubled first, otherwise CommandLineToArgvW reads it as an escape
 * and the argument boundaries shift from there on. A run at the very end
 * counts too: it sits against the closing quote.
 */
export function quoteCmd (value: string): string {
    let out = '"'
    let backslashes = 0
    for (const char of value) {
        if (char === '\\') {
            backslashes++
            continue
        }
        if (char === '"') {
            out += '\\'.repeat(backslashes * 2) + '""'
            backslashes = 0
            continue
        }
        // backslashes not followed by a quote are literal to both parsers
        out += '\\'.repeat(backslashes) + (char === '%' ? '%%' : char)
        backslashes = 0
    }
    return out + '\\'.repeat(backslashes * 2) + '"'
}

/** Quote a value for a generated /bin/sh wrapper */
export function quoteSh (value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}
