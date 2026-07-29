/**
 * Dev-only fixtures for README screenshots.
 * Enable with VIBBY_README_DEMO=1 (or localStorage vibby-readme-demo=1).
 */
import { AiEvent } from './events'
import { FloatingSessionSnapshot } from './floatingSessions'
import { AiDisplayState } from './presentation'

export function isReadmeDemo (): boolean {
    try {
        if (typeof process !== 'undefined' && process.env?.VIBBY_README_DEMO === '1') {
            return true
        }
        if (typeof localStorage !== 'undefined' && localStorage.getItem('vibby-readme-demo') === '1') {
            return true
        }
    } catch {
        // ignore storage / env access failures
    }
    return false
}

export interface ReadmeDemoSession {
    id: string
    kind: string
    name: string
    state: AiDisplayState
    stateLabel: string
    caption: string
    live: string
    ageMs: number
}

export interface ReadmeDemoActivity {
    sessionId: string
    who: string
    kind: AiEvent['kind']
    kindLabel: string
    summary: string
    ageMs: number
    state: AiDisplayState
}

export function readmeDemoLang (): 'en'|'zh' {
    try {
        if (typeof process !== 'undefined' && process.env?.VIBBY_README_DEMO_LANG === 'zh') {
            return 'zh'
        }
        if (typeof localStorage !== 'undefined' && localStorage.getItem('vibby-readme-demo-lang') === 'zh') {
            return 'zh'
        }
    } catch {
        // ignore
    }
    return 'en'
}

export const README_DEMO_SESSIONS: ReadmeDemoSession[] = [
    {
        id: 'demo-auth',
        kind: 'claude-code',
        name: 'auth-service',
        state: 'needs-you',
        stateLabel: '🙋 Your turn',
        caption: 'Waiting for approval — git push --force origin main',
        live: '',
        ageMs: 3 * 60_000 + 12_000,
    },
    {
        id: 'demo-web',
        kind: 'claude-code',
        name: 'vibby-web',
        state: 'working',
        stateLabel: '🛠️ On it',
        caption: 'edit — dashboardTab.component.ts',
        live: 'Flambéing…',
        ageMs: 41_000,
    },
    {
        id: 'demo-pi',
        kind: 'pi',
        name: 'firmware',
        state: 'working',
        stateLabel: '🛠️ On it',
        caption: 'bash — pio test -e esp32s3',
        live: '',
        ageMs: 2 * 60_000 + 5_000,
    },
    {
        id: 'demo-docs',
        kind: 'opencode',
        name: 'docs',
        state: 'idle',
        stateLabel: '✨ Standing by',
        caption: 'Turn complete · waiting for the next prompt',
        live: '',
        ageMs: 18 * 60_000,
    },
    {
        id: 'demo-pipeline',
        kind: 'codex',
        name: 'data-pipeline',
        state: 'error',
        stateLabel: '⚠️ Trouble',
        caption: 'exit code 1 · API auth failed',
        live: '',
        ageMs: 6 * 60_000,
    },
]

export const README_DEMO_ACTIVITY: ReadmeDemoActivity[] = [
    {
        sessionId: 'demo-auth',
        who: 'auth-service',
        kind: 'permission-request',
        kindLabel: 'permission',
        summary: 'Approve git push --force origin main',
        ageMs: 20_000,
        state: 'needs-you',
    },
    {
        sessionId: 'demo-web',
        who: 'vibby-web',
        kind: 'tool-call',
        kindLabel: 'edit',
        summary: 'dashboardTab.component.ts',
        ageMs: 35_000,
        state: 'working',
    },
    {
        sessionId: 'demo-pi',
        who: 'firmware',
        kind: 'tool-call',
        kindLabel: 'bash',
        summary: 'pio test -e esp32s3',
        ageMs: 90_000,
        state: 'working',
    },
    {
        sessionId: 'demo-pipeline',
        who: 'data-pipeline',
        kind: 'session-error',
        kindLabel: 'error',
        summary: 'Process exited with code 1',
        ageMs: 5 * 60_000,
        state: 'error',
    },
    {
        sessionId: 'demo-docs',
        who: 'docs',
        kind: 'turn-completed',
        kindLabel: 'turn',
        summary: 'Documentation rewrite finished',
        ageMs: 12 * 60_000,
        state: 'idle',
    },
]

export function readmeDemoSessions (): ReadmeDemoSession[] {
    if (readmeDemoLang() !== 'zh') {
        return README_DEMO_SESSIONS
    }
    return README_DEMO_SESSIONS.map(session => {
        switch (session.id) {
            case 'demo-auth':
                return { ...session, stateLabel: '🙋 该你了', caption: '等待审批 — git push --force origin main' }
            case 'demo-web':
                return { ...session, stateLabel: '🛠️ 处理中' }
            case 'demo-pi':
                return { ...session, stateLabel: '🛠️ 处理中' }
            case 'demo-docs':
                return { ...session, stateLabel: '✨ 待命', caption: '回合结束 · 等待下一条指令' }
            case 'demo-pipeline':
                return { ...session, stateLabel: '⚠️ 异常', caption: 'exit code 1 · API 认证失败' }
            default:
                return session
        }
    })
}

export function readmeDemoActivity (): ReadmeDemoActivity[] {
    if (readmeDemoLang() !== 'zh') {
        return README_DEMO_ACTIVITY
    }
    return [
        { ...README_DEMO_ACTIVITY[0], kindLabel: '审批', summary: '批准 git push --force origin main' },
        { ...README_DEMO_ACTIVITY[1], kindLabel: '编辑' },
        { ...README_DEMO_ACTIVITY[2], kindLabel: 'bash' },
        { ...README_DEMO_ACTIVITY[3], kindLabel: '错误', summary: '进程退出，退出码 1' },
        { ...README_DEMO_ACTIVITY[4], kindLabel: '回合', summary: '文档重写完成' },
    ]
}

export function readmeDemoFloatingSessions (sourceWindowId: number, now = Date.now()): FloatingSessionSnapshot[] {
    const zh = readmeDemoLang() === 'zh'
    const stateLabel: Record<string, string> = zh
        ? { 'needs-you': '等待确认', working: '运行中', idle: '已完成', error: '异常' }
        : { 'needs-you': 'Waiting', working: 'Working', idle: 'Idle', error: 'Error' }
    return readmeDemoSessions().map(session => ({
        sessionId: session.id,
        sourceWindowId,
        kind: session.kind,
        name: session.name,
        state: session.state === 'listening' || session.state === 'untracked' ? 'idle' : session.state,
        stateLabel: stateLabel[session.state] ?? session.state,
        summary: session.caption,
        createdAt: now - session.ageMs - 60_000,
        lastActivityAt: now - Math.min(session.ageMs, 45_000),
    }))
}

export function formatDemoDuration (ageMs: number): string {
    const totalSec = Math.max(0, Math.round(ageMs / 1000))
    if (totalSec < 60) {
        return `${totalSec}s`
    }
    const minutes = Math.floor(totalSec / 60)
    const seconds = totalSec % 60
    if (minutes < 60) {
        return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
    }
    return `${Math.floor(minutes / 60)}h`
}

export function formatDemoClock (ageMs: number, now = Date.now()): string {
    const date = new Date(now - ageMs)
    const hh = String(date.getHours()).padStart(2, '0')
    const mm = String(date.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
}
