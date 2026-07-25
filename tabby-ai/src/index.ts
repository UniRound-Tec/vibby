/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCorePlugin, { AppService, CLIHandler, CommandProvider, ConfigProvider, ConfigService, HotkeyProvider, HotkeysService, ProfileProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { AiConfigProvider } from './config'
import { AiCliProfileProvider } from './profiles'
import { OpenDashboardCLIHandler } from './cli'
import { AiHotkeyProvider } from './hotkeys'
import { AiSettingsTabProvider } from './settings'
import { AiCommandProvider } from './commands'
import { CliScannerService } from './services/cliScanner.service'
import { DashboardService } from './services/dashboard.service'
import { HookIngressService } from './services/hookIngress.service'
import { ClaudeAdapterService } from './services/claudeAdapter.service'
import { AiAttentionService } from './services/attention.service'
import { AiTabStateService } from './services/tabState.service'
import { COLLAPSED_CLASS, RailService } from './services/rail.service'
import { DashboardTabComponent } from './components/dashboardTab.component'
import { AiSettingsTabComponent } from './components/aiSettingsTab.component'

/** vibby brand accent. Kept in sync by hand with $accent in dashboardTab.component.scss */
const ACCENT = '#ff4500'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: AiConfigProvider, multi: true },
        { provide: ProfileProvider, useClass: AiCliProfileProvider, multi: true },
        { provide: CLIHandler, useClass: OpenDashboardCLIHandler, multi: true },
        { provide: HotkeyProvider, useClass: AiHotkeyProvider, multi: true },
        { provide: SettingsTabProvider, useClass: AiSettingsTabProvider, multi: true },
        { provide: CommandProvider, useClass: AiCommandProvider, multi: true },
    ],
    declarations: [
        DashboardTabComponent,
        AiSettingsTabComponent,
    ],
})
export default class AiModule {
    private constructor (
        scanner: CliScannerService,
        app: AppService,
        config: ConfigService,
        dashboard: DashboardService,
        hotkeys: HotkeysService,
        ingress: HookIngressService,
        claudeAdapter: ClaudeAdapterService,
        attention: AiAttentionService,
        tabState: AiTabStateService,
        rail: RailService,
    ) {
        scanner.ensureScanned()
        ingress.start().then(() => {
            console.debug(`[tabby-ai] ingress endpoint template: ${ingress.endpointFor('SESSION')}`)
        }).catch(() => null)
        claudeAdapter.activate()
        attention.activate()
        tabState.activate()
        rail.activate()
        this.injectTabBarStyles()

        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === 'toggle-dashboard') {
                dashboard.open()
            }
        })

        app.ready$.subscribe(() => {
            app.tabsChanged$.subscribe(() => {
                if (app.tabs.length === 0 && config.store.aiCli.dashboard.reopenWhenEmpty) {
                    dashboard.open()
                }
            })
        })
    }

    /**
     * Everything vibby changes about tabby's own tab bar, as one injected
     * stylesheet — restyling from here instead of editing core's SCSS keeps
     * the upstream diff at the single markup hook in tabHeader.component.pug.
     */
    private injectTabBarStyles (): void {
        // every collapsed rule shares this prefix; :is() keeps the block
        // readable where spelling both sides out would double its length
        const collapsed = `body.${COLLAPSED_CLASS} .content:is(.tabs-on-left, .tabs-on-right) > .tab-bar`
        const style = document.createElement('style')
        style.textContent = `
            /* ---- scrollbars ---- upstream's are 10px over a filled track,
               which reads as a piece of UI rather than an affordance. The
               \`body \` prefix outranks the theme's \`*\` rules whichever order
               the two stylesheets end up in — themes.service appends its
               <style> whenever the theme is first applied. */
            body ::-webkit-scrollbar {
                width: 6px;
                height: 6px;
                background: transparent;
            }
            body ::-webkit-scrollbar-thumb {
                background: color-mix(in srgb, ${ACCENT} 45%, transparent);
                border-radius: 3px;
            }
            body ::-webkit-scrollbar-thumb:hover { background: ${ACCENT}; }
            /* in the rail it shows only while the pointer is in there. Only the
               thumb's colour changes, never the track's width, so revealing it
               cannot shift the cards sideways. */
            .content.tabs-on-left > .tab-bar .tabs::-webkit-scrollbar-thumb,
            .content.tabs-on-right > .tab-bar .tabs::-webkit-scrollbar-thumb {
                background: transparent;
            }
            .content.tabs-on-left > .tab-bar:hover .tabs::-webkit-scrollbar-thumb,
            .content.tabs-on-right > .tab-bar:hover .tabs::-webkit-scrollbar-thumb {
                background: color-mix(in srgb, ${ACCENT} 55%, transparent);
            }

            /* ---- toolbar icons are Tabler, which draws with strokes ----
               both the theme and appRoot force a fill on every .btn-tab-bar
               svg, which floods a stroke icon into a solid blob. Keyed on
               [stroke] rather than a class so it covers any stroke icon,
               including the two that live in core's own icon folders. */
            .tab-bar .btn-tab-bar svg[stroke],
            .tab-bar .btn-tab-bar svg[stroke] path {
                fill: none !important;
            }

            /* ---- home is a toolbar button in every layout ----
               so its tab must never be in the list: on horizontal bars the two
               would both be visible and read as duplicates. Hiding the tab
               rather than the button keeps one affordance in one place across
               all four tabsLocation values. */
            tab-header.mini { display: none !important; }

            /* On horizontal bars the toolbar is markup-ordered after the tab
               list, so removing the mini tab would move home from the leading
               edge into the middle. The leading button group goes back to the
               front — home has to stay in the same corner in every layout.
               Safe with drag-reorder: the CDK drop list is .tabs, and it only
               ever reorders tab-headers inside it, never the bar's own children.
               Selected by adjacency, not :first-of-type — of-type counts divs,
               and .tabs is a div too, so it would never match the group. */
            .content:not(.tabs-on-left):not(.tabs-on-right) > .tab-bar > .tabs + .btn-group {
                order: -1;
            }

            /* ---- side bar: a list, not a strip of tabs ---- */
            /* cards need more room than upstream's 200px name-only rail */
            .content.tabs-on-left,
            .content.tabs-on-right {
                --side-tab-width: calc(236px * var(--spaciness));
            }
            .content.tabs-on-left > .tab-bar,
            .content.tabs-on-right > .tab-bar {
                position: relative;
                overflow: hidden !important;
                padding-bottom: 62px;
            }
            .content.tabs-on-left > .tab-bar > .tabs,
            .content.tabs-on-right > .tab-bar > .tabs {
                box-sizing: border-box;
                flex: 1 1 auto !important;
                min-height: 0;
                overflow-y: auto;
                padding: 8px 8px 0 !important;
            }
            .content.tabs-on-left > .tab-bar tab-header,
            .content.tabs-on-right > .tab-bar tab-header {
                border-radius: 8px;
                margin-bottom: 3px;
                /* core clips the header; the group heading sits above the card */
                overflow: visible !important;
                /* the theme paints every tab header in --theme-fg-more-2, its
                   secondary foreground. That reads fine on a 38px strip of
                   chrome; in a rail this wide the tab list *is* the content,
                   so it opts back into the body colour and lets the individual
                   rules below decide what gets dimmed. */
                color: var(--bs-body-color);
            }
            /* ...except the theme dims the number to .4 from a selector deep
               enough that only !important reaches it */
            .content.tabs-on-left > .tab-bar tab-header .index,
            .content.tabs-on-right > .tab-bar tab-header .index {
                opacity: .72 !important;
            }

            /* ---- group headings ---- the service labels a tab whenever the
               group changes, so this stays honest under any tab order */
            .content.tabs-on-left > .tab-bar tab-header[data-ai-group],
            .content.tabs-on-right > .tab-bar tab-header[data-ai-group] {
                margin-top: 30px;
            }
            /* the first heading has the title bar right above it, so it needs
               more clearance than the ones between groups */
            .content.tabs-on-left > .tab-bar .tabs > tab-header[data-ai-group]:first-child,
            .content.tabs-on-right > .tab-bar .tabs > tab-header[data-ai-group]:first-child {
                margin-top: 28px;
            }
            .content.tabs-on-left > .tab-bar tab-header[data-ai-group]::before,
            .content.tabs-on-right > .tab-bar tab-header[data-ai-group]::before {
                content: attr(data-ai-group);
                position: absolute;
                left: 3px;
                /* clear of the card below it, not sitting on its edge */
                top: -19px;
                font-size: 10px;
                font-weight: 600;
                letter-spacing: .16em;
                /* never inherit: the heading is not about the tab it hangs on,
                   so it must not pick up that tab's active/dimmed colour */
                color: var(--bs-body-color, currentColor);
                opacity: .58;
                pointer-events: none;
            }

            /* ---- AI sessions are cards; plain shells stay one thin row ----
               two rows, not three: identity and state share the top line and
               the event gets the bottom one. grid because the top row's items
               are core's own elements and have to keep their order. */
            .content.tabs-on-left > .tab-bar tab-header:has(.ai-state),
            .content.tabs-on-right > .tab-bar tab-header:has(.ai-state) {
                display: grid !important;
                grid-template-columns: auto auto minmax(0, 1fr) auto;
                grid-template-areas: "index icon name state" "sum sum sum sum";
                align-items: center;
                row-gap: 2px;
                column-gap: 7px;
                flex: none !important;
                height: auto !important;
                padding: 8px 10px !important;
                margin-bottom: 8px;
                background: rgba(128, 128, 128, .08);
                border: 1px solid rgba(128, 128, 128, .18);
            }
            /* the card's own border carries the selection here — the leading
               bar would collide with it */
            .content.tabs-on-left > .tab-bar tab-header:has(.ai-state).active,
            .content.tabs-on-right > .tab-bar tab-header:has(.ai-state).active {
                border-color: color-mix(in srgb, ${ACCENT} 50%, transparent);
                background: color-mix(in srgb, ${ACCENT} 6%, rgba(128, 128, 128, .08));
            }
            .content.tabs-on-left > .tab-bar tab-header:has(.ai-state) .current-tab-indicator,
            .content.tabs-on-right > .tab-bar tab-header:has(.ai-state) .current-tab-indicator {
                display: none !important;
            }
            .content.tabs-on-left > .tab-bar tab-header:has(.ai-state) .index,
            .content.tabs-on-right > .tab-bar tab-header:has(.ai-state) .index {
                grid-area: index;
                width: auto !important;
                min-width: 11px;
                font-size: 11px;
            }
            .content.tabs-on-left > .tab-bar tab-header:has(.ai-state) .name,
            .content.tabs-on-right > .tab-bar tab-header:has(.ai-state) .name {
                grid-area: name;
                font-size: 13px;
                font-weight: 600;
                margin-left: 0 !important;
            }

            .content.tabs-on-left > .tab-bar .ai-icon,
            .content.tabs-on-right > .tab-bar .ai-icon {
                grid-area: icon;
                display: flex;
                align-items: center;
            }
            .ai-icon svg { width: 14px; height: 14px; display: block; }

            .content.tabs-on-left > .tab-bar .ai-state,
            .content.tabs-on-right > .tab-bar .ai-state {
                grid-area: state;
                display: flex;
                align-items: center;
                gap: 5px;
                font-size: 10px;
                line-height: 1.7;
                padding: 0 6px;
                border-radius: 5px;
                background: rgba(128, 128, 128, .18);
            }
            /* core's options/close overlay lands on the same corner as the chip;
               it wins on hover, the chip steps aside */
            .content.tabs-on-left > .tab-bar tab-header:hover .ai-state,
            .content.tabs-on-right > .tab-bar tab-header:hover .ai-state {
                opacity: 0;
                transition: .15s opacity;
            }
            /* and the overlay stays on the identity row, off the event line */
            .content.tabs-on-left > .tab-bar tab-header:has(.ai-state) .buttons,
            .content.tabs-on-right > .tab-bar tab-header:has(.ai-state) .buttons {
                top: 6px !important;
                height: 24px !important;
            }

            .ai-state::before {
                content: '';
                width: 5px;
                height: 5px;
                border-radius: 50%;
                background: currentColor;
                flex: none;
            }
            .ai-state.working { color: var(--bs-blue, #61afef); background: color-mix(in srgb, var(--bs-blue, #61afef) 16%, transparent); }
            .ai-state.idle { color: var(--bs-green, #98c379); background: color-mix(in srgb, var(--bs-green, #98c379) 16%, transparent); }
            .ai-state.error { color: var(--bs-red, #e06c75); background: color-mix(in srgb, var(--bs-red, #e06c75) 18%, transparent); }
            .ai-state.untracked { color: var(--bs-body-color, currentColor); opacity: .78; }
            .ai-state.needs-you {
                color: var(--bs-yellow, #f0c674);
                background: color-mix(in srgb, var(--bs-yellow, #f0c674) 20%, transparent);
                animation: vibby-dot-breathe 2.2s ease-in-out infinite;
            }
            .content.tabs-on-left > .tab-bar .ai-summary,
            .content.tabs-on-right > .tab-bar .ai-summary {
                grid-area: sum;
                font-family: monospace;
                font-size: 10.5px;
                line-height: 1.5;
                /* only the state chip is allowed to carry colour in a card, so
                   the event line never inherits an active tab's highlight */
                color: var(--bs-body-color, currentColor);
                opacity: .65;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            /* horizontal bars: no room for the event line, and the chip shrinks
               to its dot alone (font-size 0 leaves ::before at its own size) */
            .content:not(.tabs-on-left):not(.tabs-on-right) .ai-summary,
            .content:not(.tabs-on-left):not(.tabs-on-right) .ai-icon { display: none; }
            .content:not(.tabs-on-left):not(.tabs-on-right) .ai-state {
                display: flex;
                flex: none;
                align-items: center;
                align-self: center;
                margin-left: 7px;
                font-size: 0;
                padding: 0;
                background: none !important;
            }
            .content.tabs-on-left > .tab-bar tab-header:not(.active):hover,
            .content.tabs-on-right > .tab-bar tab-header:not(.active):hover {
                background: rgba(128, 128, 128, .12);
            }
            /* the current-tab bar is designed for horizontal strips (2px along
               the top edge); on a side bar it has to ride the leading edge */
            .content.tabs-on-left > .tab-bar .current-tab-indicator,
            .content.tabs-on-right > .tab-bar .current-tab-indicator {
                top: 7px !important;
                bottom: 7px !important;
                left: 0 !important;
                right: auto !important;
                width: 3px !important;
                height: auto !important;
                border-radius: 0 3px 3px 0;
                background: ${ACCENT} !important;
            }
            /* the unread-activity underline has the same problem and no room to
               solve it: a 2px line inset 10px from both edges reads as a stray
               divider inside a card. A dot on the trailing edge says the same
               thing without being mistaken for structure. */
            .content.tabs-on-left > .tab-bar .activity-indicator,
            .content.tabs-on-right > .tab-bar .activity-indicator {
                top: 50%;
                bottom: auto !important;
                left: auto !important;
                right: 8px !important;
                width: 5px !important;
                height: 5px !important;
                margin-top: -2px;
                border-radius: 50%;
                opacity: .55;
            }
            /* in a card the chip already occupies that corner, so the dot goes
               on the event line's own row instead of on top of the chip */
            .content.tabs-on-left > .tab-bar tab-header:has(.ai-state) .activity-indicator,
            .content.tabs-on-right > .tab-bar tab-header:has(.ai-state) .activity-indicator {
                top: auto;
                bottom: 11px !important;
                margin-top: 0;
            }
            /* collapsed: the state badge owns the top-right corner, so this
               sits bottom-right and cannot be read as a divider */
            ${collapsed} .activity-indicator {
                top: auto !important;
                bottom: 5px !important;
                right: 5px !important;
                margin-top: 0;
            }

            /* ---- side bar: one toolbar pinned at the bottom ---- */
            .content.tabs-on-left > .tab-bar > .btn-group,
            .content.tabs-on-right > .tab-bar > .btn-group {
                position: absolute;
                bottom: 10px;
                left: 10px;
                gap: 6px;
                z-index: 2;
            }
            .content.tabs-on-left > .tab-bar > .btn-space ~ .btn-group,
            .content.tabs-on-right > .tab-bar > .btn-space ~ .btn-group {
                left: auto;
                right: 10px;
            }
            .content.tabs-on-left > .tab-bar::after,
            .content.tabs-on-right > .tab-bar::after {
                content: '';
                position: absolute;
                left: 10px;
                right: 10px;
                bottom: 56px;
                height: 1px;
                background: rgba(128, 128, 128, .18);
            }
            .content.tabs-on-left > .tab-bar .btn-tab-bar,
            .content.tabs-on-right > .tab-bar .btn-tab-bar {
                width: 40px !important;
                height: 36px !important;
                /* !important: appRoot's own component-scoped rule squares these
                   off, and an [_ngcontent] attribute outranks anything we can
                   write from outside the component */
                border-radius: 9px !important;
                opacity: .9;
            }
            .content.tabs-on-left > .tab-bar .btn-tab-bar svg,
            .content.tabs-on-right > .tab-bar .btn-tab-bar svg {
                width: 17px;
                height: 17px;
            }
            /* the theme dims every toolbar icon to .75 fill on top of the
               button's own opacity — .56 effective, which is where the "faint"
               look comes from. The rail dims once, not twice. */
            .content.tabs-on-left > .tab-bar .btn-tab-bar svg,
            .content.tabs-on-left > .tab-bar .btn-tab-bar svg path,
            .content.tabs-on-right > .tab-bar .btn-tab-bar svg,
            .content.tabs-on-right > .tab-bar .btn-tab-bar svg path {
                fill-opacity: 1;
            }
            .content.tabs-on-left > .tab-bar .btn-tab-bar:hover,
            .content.tabs-on-right > .tab-bar .btn-tab-bar:hover { opacity: 1; }

            /* home is the first button of the leading group (weight -10) */
            /* !important: the theme colours every .tab-bar button from a
               deeper selector than anything we can write here */
            .content.tabs-on-left > .tab-bar > .btn-group .d-flex:first-child .btn-tab-bar,
            .content.tabs-on-right > .tab-bar > .btn-group .d-flex:first-child .btn-tab-bar {
                color: ${ACCENT} !important;
                background: color-mix(in srgb, ${ACCENT} 13%, transparent);
                opacity: 1;
            }
            /* the icon's own stroke="currentColor" already follows the colour
               above; only the theme's forced fill has to be undone, and the
               svg[stroke] rule at the top of this sheet does that. Nothing
               else needed here — a fill would flood a stroke icon solid. */
            /* ...but not the trailing group's, which starts with settings */
            .content.tabs-on-left > .tab-bar > .btn-space ~ .btn-group .d-flex:first-child .btn-tab-bar,
            .content.tabs-on-right > .tab-bar > .btn-space ~ .btn-group .d-flex:first-child .btn-tab-bar {
                color: inherit !important;
                background: none;
                opacity: .75;
            }

            /* ---- AI session state dot (markup hook lives in tabHeader.component.pug) ---- */
            tab-header .ai-state-dot {
                flex: none;
                align-self: center;
                width: 7px;
                height: 7px;
                margin-left: 8px;
                border-radius: 50%;
                background: rgba(128, 128, 128, .5);
            }
            tab-header .ai-state-dot.working { background: var(--bs-blue, #61afef); }
            tab-header .ai-state-dot.idle { background: var(--bs-green, #98c379); }
            tab-header .ai-state-dot.error { background: var(--bs-red, #e06c75); }
            tab-header .ai-state-dot.needs-you {
                background: var(--bs-yellow, #f0c674);
                animation: vibby-dot-breathe 2.2s ease-in-out infinite;
            }
            /* the hover buttons overlay the same corner */
            tab-header:hover .ai-state-dot { opacity: 0; }

            /* ---- collapsed rail ---- icons only; RailService owns the body
               class, so nothing outside this block knows the state exists.
               The action is meaningless on horizontal bars, so is its button. */
            .content:not(.tabs-on-left):not(.tabs-on-right) .btn-tab-bar:has(svg.vibby-rail-toggle) {
                display: none !important;
            }
            body.${COLLAPSED_CLASS} .btn-tab-bar:has(svg.vibby-rail-toggle) {
                background: rgba(128, 128, 128, .2);
                opacity: 1;
            }
            body.${COLLAPSED_CLASS} .content.tabs-on-left,
            body.${COLLAPSED_CLASS} .content.tabs-on-right {
                --side-tab-width: calc(58px * var(--spaciness));
            }
            /* the toolbar stops being one row pinned to the bottom and becomes
               a column, which is the only thing that fits at this width */
            ${collapsed} { padding-bottom: 8px; min-height: 0; }
            /* a stacked toolbar raises the rail's min-content height above the
               viewport, and a flex item defaults to min-height:auto — without
               this the whole window layout is pushed past the bottom edge */
            body.${COLLAPSED_CLASS} .window { min-height: 0; }
            ${collapsed}::after { display: none; }
            ${collapsed} > .btn-group {
                position: static !important;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 4px;
            }
            ${collapsed} > .btn-space { flex: none !important; height: 0 !important; }
            ${collapsed} > .tabs + .btn-group {
                margin: 6px 9px 0;
                padding-top: 8px;
                border-top: 1px solid rgba(128, 128, 128, .18);
            }

            /* one square per tab: the icon carries the identity and the tooltip
               (core binds it to the title) carries the name */
            ${collapsed} tab-header {
                display: flex !important;
                align-items: center;
                justify-content: center;
                position: relative;
                flex: none !important;
                height: 38px !important;
                padding: 0 !important;
                margin-bottom: 4px;
            }
            /* ...but not the home tab. The rule above also carries !important,
               so the global \`tab-header.mini { display: none }\` loses to it on
               specificity — this scope has to hide it again itself. */
            ${collapsed} tab-header.mini { display: none !important; }
            ${collapsed} tab-header .name,
            ${collapsed} tab-header .ai-summary,
            ${collapsed} tab-header .buttons { display: none !important; }
            /* no room for a close button — the right-click menu still has one */
            ${collapsed} tab-header .index {
                grid-area: auto;
                min-width: 0 !important;
                font-size: 11px;
            }
            /* the number is a fallback: it only shows when nothing better does */
            ${collapsed} tab-header:has(.ai-icon) .index,
            ${collapsed} tab-header:has(profile-icon) .index { display: none !important; }
            ${collapsed} .ai-icon { opacity: .85; }
            ${collapsed} .ai-icon svg { width: 16px; height: 16px; }

            /* the state chip shrinks to a badge on the icon's corner */
            ${collapsed} .ai-state {
                position: absolute;
                top: 4px;
                right: 4px;
                display: block !important;
                width: 6px;
                height: 6px;
                padding: 0 !important;
                border-radius: 50%;
                font-size: 0 !important;
                line-height: 0 !important;
                background: currentColor !important;
            }
            ${collapsed} .ai-state::before { display: none; }
            /* nothing overlays it here, so it has no reason to fade on hover */
            ${collapsed} tab-header:hover .ai-state { opacity: 1; }
            ${collapsed} tab-header:hover .ai-state.untracked { opacity: .78; }

            /* group headings have no room for a label — a rule says the same */
            ${collapsed} tab-header[data-ai-group] { margin-top: 15px; }
            ${collapsed} tab-header[data-ai-group]::before {
                content: '';
                left: 5px;
                right: 5px;
                top: -8px;
                height: 1px;
                background: rgba(128, 128, 128, .3);
                opacity: 1;
            }
            /* ...and the first group needs no divider: nothing is above it.
               the hidden home tab still counts as :first-child, so the second
               selector catches the case where it is open */
            ${collapsed} .tabs > tab-header[data-ai-group]:first-child,
            ${collapsed} .tabs > tab-header.mini + tab-header[data-ai-group] { margin-top: 6px; }
            ${collapsed} .tabs > tab-header[data-ai-group]:first-child::before,
            ${collapsed} .tabs > tab-header.mini + tab-header[data-ai-group]::before { display: none; }

            @keyframes vibby-dot-breathe {
                0%, 100% { opacity: 1; }
                50% { opacity: .3; }
            }
        `
        document.head.appendChild(style)
    }
}

export * from './api'
