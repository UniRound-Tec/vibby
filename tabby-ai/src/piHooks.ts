import { AiEvent } from './events'
import { appendWslenv } from './runtimeTargets'

export const PI_HOOK_ENDPOINT_ENV = 'VIBBY_PI_HOOK_ENDPOINT'
export const PI_HOOK_DROP_DIR_ENV = 'VIBBY_PI_HOOK_DROP_DIR'
export const PI_HOOK_SESSION_ENV = 'VIBBY_PI_HOOK_SESSION_ID'

function text (value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function record (value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function basename (value: unknown): string {
    const path = text(value)
    const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return index >= 0 ? path.slice(index + 1) : path
}

/** Never expose command arguments: prompts and credentials often live there. */
function commandName (value: unknown): string {
    const command = text(value).trim()
    const first = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command)?.slice(1).find(Boolean) ?? ''
    return basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '') || 'command'
}

function toolSummary (toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
        case 'Bash':
        case 'bash':
            return `command: ${commandName(input['command'])}`
        case 'apply_patch':
        case 'Edit':
        case 'Write':
        case 'Read':
            return `${toolName === 'Read' ? 'read' : 'edit'}: ${basename(input['file_path'] ?? input['path']) || 'files'}`
        case 'Agent':
        case 'spawn_agent':
            return 'agent'
        default:
            return `tool: ${toolName || 'working'}`
    }
}

/**
 * Environment variables passed to a Pi session so its generated extension knows
 * where to send events. Native sessions post to the loopback HTTP endpoint;
 * WSL sessions write to a drop directory because NAT-mode distros cannot reach
 * the Windows host loopback reliably.
 */
export function piHookEnvironment (
    endpoint: string,
    dropDir?: string | null,
    sessionId?: string,
    existingEnv: Record<string, string> = {},
): Record<string, string> {
    const env: Record<string, string> = {
        ...existingEnv,
        [PI_HOOK_ENDPOINT_ENV]: endpoint,
    }
    if (dropDir && sessionId) {
        env[PI_HOOK_DROP_DIR_ENV] = dropDir
        env[PI_HOOK_SESSION_ENV] = sessionId
        env.WSLENV = appendWslenv(existingEnv.WSLENV, [PI_HOOK_DROP_DIR_ENV, PI_HOOK_SESSION_ENV])
    }
    return env
}

/**
 * Generates a self-contained Pi extension that forwards lifecycle hooks to vibby.
 *
 * The source uses only Node.js built-ins so it has no external dependencies when
 * loaded by `pi -e <path>`. The endpoint is not baked in; it is read from the
 * environment so the same cached/generated source can be reused across sessions
 * if desired.
 */
export function buildPiExtensionSource (
    endpoint: string,
    dropDir?: string,
    sessionId?: string,
): string {
    return `import * as fs from "fs"
import * as path from "path"
import * as http from "http"

const ENDPOINT = process.env.${PI_HOOK_ENDPOINT_ENV}
const DROP_DIR = process.env.${PI_HOOK_DROP_DIR_ENV}
const SESSION_ID = process.env.${PI_HOOK_SESSION_ENV}

function sendEvent(piEvent) {
    if (!ENDPOINT && !DROP_DIR) return
    const payload = { ...piEvent, vibby_session_id: SESSION_ID }
    const body = JSON.stringify(payload)

    if (DROP_DIR && SESSION_ID) {
        const nonce = Math.random().toString(36).slice(2)
        const tmp = path.join(DROP_DIR, SESSION_ID + "." + nonce)
        try {
            fs.writeFileSync(tmp, body)
            fs.renameSync(tmp, tmp + ".json")
        } catch {}
        return
    }

    if (ENDPOINT) {
        let url
        try {
            url = new URL(ENDPOINT)
        } catch {
            return
        }
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            timeout: 3000,
        }, () => {})
        req.on("error", () => {})
        req.write(body)
        req.end()
    }
}

export default function (pi) {
    pi.on("session_start", (event) => sendEvent({ type: "session_start", event }))
    pi.on("input", (event) => sendEvent({ type: "input", event }))
    pi.on("tool_call", (event) => sendEvent({ type: "tool_call", event }))
    pi.on("tool_result", (event) => sendEvent({ type: "tool_result", event }))
    pi.on("turn_end", (event) => sendEvent({ type: "turn_end", event }))
    pi.on("agent_end", (event) => sendEvent({ type: "agent_end", event }))
    pi.on("session_shutdown", (event) => sendEvent({ type: "session_shutdown", event }))
}
`
}

/**
 * Converts Pi extension hook payloads to the vibby event protocol.
 *
 * Privacy rules mirror claudeHooks/codexHooks: prompts reach the summary, but
 * tool inputs, raw results, and file contents do not.
 */
export function translatePiHook (
    sessionId: string,
    payload: unknown,
    ts: number,
): AiEvent | null {
    const value = record(payload)
    const piType = text(value['type'])
    const event = record(value['event'])
    const base = { sessionId, ts, confidence: 'high' as const }

    switch (piType) {
        case 'session_start':
            return { ...base, kind: 'session-started', summary: 'ready' }
        case 'input': {
            if (text(event['source']) === 'extension') {
                return null
            }
            return { ...base, kind: 'prompt-submitted', summary: `user: ${text(event['text'])}` }
        }
        case 'tool_call': {
            const toolName = text(event['toolName'])
            return { ...base, kind: 'tool-call', summary: toolSummary(toolName, record(event['input'])) }
        }
        case 'tool_result': {
            const toolName = text(event['toolName'])
            return { ...base, kind: 'tool-result', summary: `tool: ${toolName || 'working'}` }
        }
        case 'turn_end':
            return { ...base, kind: 'turn-completed', summary: 'done' }
        case 'agent_end':
            return { ...base, kind: 'session-ended', summary: 'ended' }
        case 'session_shutdown':
            return { ...base, kind: 'session-ended', summary: 'ended' }
        default:
            return null
    }
}
