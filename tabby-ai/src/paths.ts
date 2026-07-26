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
 * Whether a directory's contents are all things we wrote. The name check alone
 * cannot rule out a collision, and the sweep is a recursive delete, so the
 * contents get a say before anything is removed.
 */
export function holdsOnlyGeneratedFiles (entries: string[]): boolean {
    return entries.every(entry => entry.endsWith('.json') || entry.startsWith(SHIM_DIR_PREFIX))
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
