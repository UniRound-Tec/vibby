import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable, Subject } from 'rxjs'
import {
    AiEvent, AiSessionSnapshot, AiSessionState,
    clampSummary, isAttentionTransition, reduceSnapshot,
} from '../events'

export interface AiAttentionPulse {
    sessionId: string
    from: AiSessionState
    to: AiSessionState
    event: AiEvent
}

/** Per-session ring buffer size for the dashboard hover feed */
export const FEED_LENGTH = 30

/**
 * In-app event bus (D6): adapters publish, the dashboard / notifications /
 * (M3) device output subscribe. State machine lives in events.ts as a pure
 * reducer — this service only holds the per-session bookkeeping.
 */
@Injectable({ providedIn: 'root' })
export class AiEventBusService {
    private snapshots = new Map<string, AiSessionSnapshot>()
    private feeds = new Map<string, AiEvent[]>()

    private events = new Subject<AiEvent>()
    private attention = new Subject<AiAttentionPulse>()
    private snapshotsSubject = new BehaviorSubject<ReadonlyMap<string, AiSessionSnapshot>>(this.snapshots)

    get events$ (): Observable<AiEvent> { return this.events }
    get attention$ (): Observable<AiAttentionPulse> { return this.attention }
    get snapshots$ (): Observable<ReadonlyMap<string, AiSessionSnapshot>> { return this.snapshotsSubject }

    publish (event: AiEvent): void {
        event = { ...event, summary: clampSummary(event.summary) }

        const prev = this.snapshots.get(event.sessionId) ?? null
        const next = reduceSnapshot(prev, event)
        this.snapshots.set(event.sessionId, next)

        const feed = this.feeds.get(event.sessionId) ?? []
        feed.push(event)
        this.feeds.set(event.sessionId, feed.slice(-FEED_LENGTH))

        this.events.next(event)
        if (isAttentionTransition(prev?.state ?? null, next.state)) {
            this.attention.next({
                sessionId: event.sessionId,
                from: prev!.state,
                to: next.state,
                event,
            })
        }
        this.snapshotsSubject.next(this.snapshots)
    }

    snapshotFor (sessionId: string): AiSessionSnapshot | null {
        return this.snapshots.get(sessionId) ?? null
    }

    feedFor (sessionId: string): AiEvent[] {
        return this.feeds.get(sessionId) ?? []
    }

    /** Forget a session entirely (its tab is gone) */
    dropSession (sessionId: string): void {
        if (this.snapshots.delete(sessionId)) {
            this.snapshotsSubject.next(this.snapshots)
        }
        this.feeds.delete(sessionId)
    }
}
