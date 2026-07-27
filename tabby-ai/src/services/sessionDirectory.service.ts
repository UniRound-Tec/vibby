import { Injectable } from '@angular/core'
import { TerminalTabComponent } from 'tabby-local'

import { AiSessionBinding, AiSessionDirectory } from '../monitoring'

/**
 * The only pane/session identity seam exposed to dashboard, rail and
 * notifications. Vendor adapters own transports; this directory owns neither
 * events nor snapshots.
 *
 * A manual shell may be pre-armed for more than one CLI. The optional kind on
 * forPane() selects the adapter that RuntimeCliDetectorService actually sees.
 */
@Injectable({ providedIn: 'root' })
export class AiSessionDirectoryService implements AiSessionDirectory {
    private byPane = new WeakMap<TerminalTabComponent, Map<string, AiSessionBinding>>()
    private bySession = new Map<string, AiSessionBinding>()

    bind (binding: AiSessionBinding): void {
        const previous = this.bySession.get(binding.sessionId)
        if (previous && previous !== binding) {
            this.unbind(binding.sessionId)
        }
        let bindings = this.byPane.get(binding.pane)
        if (!bindings) {
            bindings = new Map()
            this.byPane.set(binding.pane, bindings)
        }
        const replaced = bindings.get(binding.kind)
        if (replaced && replaced.sessionId !== binding.sessionId) {
            this.bySession.delete(replaced.sessionId)
        }
        bindings.set(binding.kind, binding)
        this.bySession.set(binding.sessionId, binding)
    }

    unbind (sessionId: string): void {
        const binding = this.bySession.get(sessionId)
        if (!binding) {
            return
        }
        this.bySession.delete(sessionId)
        const bindings = this.byPane.get(binding.pane)
        bindings?.delete(binding.kind)
        if (bindings?.size === 0) {
            this.byPane.delete(binding.pane)
        }
    }

    forPane (pane: TerminalTabComponent, kind?: string|null): AiSessionBinding|null {
        const bindings = this.byPane.get(pane)
        if (!bindings) {
            return null
        }
        if (kind) {
            return bindings.get(kind) ?? null
        }
        return bindings.size === 1 ? bindings.values().next().value ?? null : null
    }

    forSession (sessionId: string): AiSessionBinding|null {
        return this.bySession.get(sessionId) ?? null
    }
}
