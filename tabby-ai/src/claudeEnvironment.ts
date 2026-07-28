/**
 * Environment markers Claude sets in its own process. A Vibby development
 * instance launched from Claude/Codex must not leak these into a child Claude
 * session, or the child can mis-detect itself as nested.
 */
export const CLAUDE_ENV_MARKERS = [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
] as const

/**
 * Agent-hosted development builds can inherit these from Codex/Claude. They
 * describe the host process, not the PTY, and would suppress Claude's own
 * truecolor output even though the terminal advertises truecolor support.
 */
export const CLAUDE_COLOR_SUPPRESSION_MARKERS = [
    'NO_COLOR',
    'FORCE_COLOR',
] as const

/** Empty values beat inherited values in mergeEnv and read as unset. */
export function claudeEnvironmentOverrides (): Record<string, string> {
    return Object.fromEntries([
        ...CLAUDE_ENV_MARKERS,
        ...CLAUDE_COLOR_SUPPRESSION_MARKERS,
    ].map(key => [key, '']))
}
