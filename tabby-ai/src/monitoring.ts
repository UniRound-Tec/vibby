import { InjectionToken } from '@angular/core'
import { TerminalTabComponent } from 'tabby-local'

import { DetectedCli } from './api'

export interface AiSessionBinding {
    /** Vibby pane-level session id, also used by AiEvent.sessionId. */
    readonly sessionId: string
    readonly kind: string
    readonly pane: TerminalTabComponent
}

export interface AiSessionDirectory {
    forPane: (pane: TerminalTabComponent, kind?: string|null) => AiSessionBinding|null
    forSession: (sessionId: string) => AiSessionBinding|null
}

export interface AiMonitorContext {
    readonly pane: TerminalTabComponent
    readonly launch: 'direct'|'manual'
    readonly detected: DetectedCli|null
}

export interface AiMonitorHandle {
    readonly binding: AiSessionBinding
    dispose: () => void
}

export interface AiCliMonitorAdapter {
    readonly kind: string
    arm: (context: AiMonitorContext) => AiMonitorHandle|null
}

export const AI_CLI_MONITOR_ADAPTERS =
    new InjectionToken<readonly AiCliMonitorAdapter[]>('AI_CLI_MONITOR_ADAPTERS')
