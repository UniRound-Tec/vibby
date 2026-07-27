import './floatingSessions.scss'

import { AI_CLI_REGISTRY } from '../../tabby-ai/src/registry'
import {
    FLOATING_SESSION_COLLAPSED_LIMIT,
    FloatingSessionSnapshot,
    FloatingSessionWindowSnapshot,
    FloatingWindowColorScheme,
    visibleFloatingSessions,
} from '../../tabby-ai/src/floatingSessions'
import './floatingSessions.api'

const icons = new Map(AI_CLI_REGISTRY.map(entry => [entry.id, entry.icon]))

let snapshot: FloatingSessionWindowSnapshot = {
    colorScheme: 'dark',
    sessions: [],
}
let expanded = false

function relativeTime (timestamp: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    if (seconds < 60) {
        return formatter.format(-seconds, 'second')
    }
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) {
        return formatter.format(-minutes, 'minute')
    }
    const hours = Math.round(minutes / 60)
    if (hours < 24) {
        return formatter.format(-hours, 'hour')
    }
    return formatter.format(-Math.round(hours / 24), 'day')
}

function element <K extends keyof HTMLElementTagNameMap> (
    tag: K,
    className?: string,
): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag)
    if (className) {
        result.className = className
    }
    return result
}

const root = document.getElementById('floating-session-root')!
const panel = element('section', 'panel')
const dragHandle = element('div', 'drag-handle')
dragHandle.setAttribute('aria-hidden', 'true')
const list = element('div', 'session-list')
const footer = element('footer', 'panel-footer')
const expandButton = element('button', 'expand-button')
expandButton.type = 'button'
const expandCount = element('span')
const expandChevron = element('span', 'expand-chevron')
expandButton.append(expandCount, expandChevron)
footer.appendChild(expandButton)
panel.append(dragHandle, list, footer)
root.appendChild(panel)

const sessionElements = new Map<string, HTMLButtonElement>()
let dragPointerId: number | null = null
let dragScreenX = 0
let dragScreenY = 0

function finishDragging (event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) {
        return
    }
    dragHandle.classList.remove('dragging')
    if (dragHandle.hasPointerCapture(event.pointerId)) {
        dragHandle.releasePointerCapture(event.pointerId)
    }
    dragPointerId = null
}

dragHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0) {
        return
    }
    event.preventDefault()
    dragPointerId = event.pointerId
    dragScreenX = event.screenX
    dragScreenY = event.screenY
    dragHandle.setPointerCapture(event.pointerId)
    dragHandle.classList.add('dragging')
})

dragHandle.addEventListener('pointermove', event => {
    if (event.pointerId !== dragPointerId || !(event.buttons & 1)) {
        return
    }
    const deltaX = event.screenX - dragScreenX
    const deltaY = event.screenY - dragScreenY
    dragScreenX = event.screenX
    dragScreenY = event.screenY
    if (deltaX || deltaY) {
        window.floatingSessions.moveWindow(deltaX, deltaY)
    }
})

dragHandle.addEventListener('pointerup', finishDragging)
dragHandle.addEventListener('pointercancel', finishDragging)

function renderIcon (session: FloatingSessionSnapshot): HTMLElement {
    const container = element('span', 'session-icon')
    const icon = icons.get(session.kind)
    if (icon) {
        const image = element('img')
        image.src = icon
        image.alt = ''
        container.appendChild(image)
    } else {
        const fallback = element('span', 'session-icon-fallback')
        fallback.textContent = session.kind.slice(0, 1).toUpperCase()
        container.appendChild(fallback)
    }
    return container
}

function updateSessionElement (
    button: HTMLButtonElement,
    session: FloatingSessionSnapshot,
): void {
    button.className = `session ${session.state}`
    button.title = session.summary ?? session.name
    button.dataset.sessionId = session.sessionId
    button.dataset.sourceWindowId = String(session.sourceWindowId)
    button.dataset.lastActivityAt = String(session.lastActivityAt)

    if (button.dataset.kind !== session.kind) {
        button.querySelector('.session-icon')?.replaceWith(renderIcon(session))
        button.dataset.kind = session.kind
    }

    button.querySelector<HTMLElement>('.session-name')!.textContent = session.name
    button.querySelector<HTMLElement>('.session-state')!.textContent = session.stateLabel
    button.querySelector<HTMLElement>('.session-event')!.textContent = session.summary ?? ''
    button.querySelector<HTMLElement>('.session-time')!.textContent = relativeTime(session.lastActivityAt)
}

function createSessionElement (session: FloatingSessionSnapshot): HTMLButtonElement {
    const button = element('button', `session ${session.state}`)
    button.type = 'button'
    button.addEventListener('click', () => {
        const sourceWindowId = Number(button.dataset.sourceWindowId)
        const sessionId = button.dataset.sessionId
        if (Number.isInteger(sourceWindowId) && sessionId) {
            window.floatingSessions.focusSession(sourceWindowId, sessionId)
        }
    })

    button.appendChild(renderIcon(session))

    const content = element('span', 'session-content')
    const heading = element('span', 'session-heading')
    const dot = element('span', 'status-dot')
    const name = element('span', 'session-name')
    const state = element('span', 'session-state')
    heading.append(dot, name, state)

    const event = element('span', 'session-event')
    content.append(heading, event)

    const time = element('span', 'session-time')

    button.append(content, time)
    button.dataset.kind = session.kind
    updateSessionElement(button, session)
    return button
}

function requestWindowSize (): void {
    requestAnimationFrame(() => {
        const bodyStyle = getComputedStyle(document.body)
        const panelStyle = getComputedStyle(panel)
        const bodyPadding =
            parseFloat(bodyStyle.paddingTop) +
            parseFloat(bodyStyle.paddingBottom)
        const panelBorder =
            parseFloat(panelStyle.borderTopWidth) +
            parseFloat(panelStyle.borderBottomWidth)
        const footerHeight = footer.offsetHeight
        const preferredHeight = Math.ceil(
            bodyPadding +
            panelBorder +
            dragHandle.offsetHeight +
            list.scrollHeight +
            footerHeight,
        )
        window.floatingSessions.setExpanded(expanded, preferredHeight)
    })
}

function updateExpandButton (): void {
    const expandable = snapshot.sessions.length > FLOATING_SESSION_COLLAPSED_LIMIT
    footer.hidden = !expandable
    if (!expandable) {
        expanded = false
        return
    }
    expandButton.setAttribute('aria-label', expanded ? 'Collapse sessions' : 'Show all sessions')
    expandCount.textContent = expanded
        ? '−'
        : `+${snapshot.sessions.length - FLOATING_SESSION_COLLAPSED_LIMIT}`
    expandChevron.textContent = expanded ? '⌃' : '⌄'
}

function applyColorScheme (colorScheme: FloatingWindowColorScheme): void {
    document.documentElement.dataset.colorScheme = colorScheme
}

function updateVisibleSessions (): void {
    const desiredElements: HTMLButtonElement[] = []
    for (const session of visibleFloatingSessions(snapshot.sessions, expanded)) {
        let button = sessionElements.get(session.sessionId)
        if (!button) {
            button = createSessionElement(session)
            sessionElements.set(session.sessionId, button)
        } else {
            updateSessionElement(button, session)
        }
        desiredElements.push(button)
    }

    desiredElements.forEach((button, index) => {
        const current = list.children.item(index)
        if (current !== button) {
            list.insertBefore(button, current)
        }
    })
    while (list.children.length > desiredElements.length) {
        list.lastElementChild?.remove()
    }

    const liveIds = new Set(snapshot.sessions.map(session => session.sessionId))
    for (const sessionId of sessionElements.keys()) {
        if (!liveIds.has(sessionId)) {
            sessionElements.delete(sessionId)
        }
    }
}

function updateRelativeTimes (): void {
    for (const button of sessionElements.values()) {
        if (!button.isConnected) {
            continue
        }
        const timestamp = Number(button.dataset.lastActivityAt)
        if (Number.isFinite(timestamp)) {
            button.querySelector<HTMLElement>('.session-time')!.textContent = relativeTime(timestamp)
        }
    }
}

function render (): void {
    applyColorScheme(snapshot.colorScheme)
    updateExpandButton()
    updateVisibleSessions()
    requestWindowSize()
}

function toggleExpanded (): void {
    expanded = !expanded
    render()
}

expandButton.addEventListener('click', toggleExpanded)
window.floatingSessions.onSnapshot(next => {
    snapshot = next
    if (snapshot.sessions.length <= FLOATING_SESSION_COLLAPSED_LIMIT) {
        expanded = false
    }
    render()
})

window.setInterval(updateRelativeTimes, 30_000)
window.floatingSessions.ready()
