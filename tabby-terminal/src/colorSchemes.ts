import { Injectable } from '@angular/core'
import { TerminalColorSchemeProvider } from './api/colorSchemeProvider'
import { TerminalColorScheme } from 'tabby-core'

@Injectable({ providedIn: 'root' })
export class DefaultColorSchemes extends TerminalColorSchemeProvider {
    static defaultColorScheme: TerminalColorScheme = {
        name: 'Tabby Default',
        foreground: '#cacaca',
        background: '#171717',
        cursor: '#bbbbbb',
        colors: [
            '#000000',
            '#ff615a',
            '#b1e969',
            '#ebd99c',
            '#5da9f6',
            '#e86aff',
            '#82fff7',
            '#dedacf',
            '#313131',
            '#f58c80',
            '#ddf88f',
            '#eee5b2',
            '#a5c7ff',
            '#ddaaff',
            '#b7fff9',
            '#ffffff',
        ],
    }

    static defaultLightColorScheme: TerminalColorScheme = {
        name: 'Tabby Default Light',
        foreground: '#4d4d4c',
        background: '#ffffff',
        cursor: '#4d4d4c',
        colors: [
            '#000000',
            '#c82829',
            '#718c00',
            '#eab700',
            '#4271ae',
            '#8959a8',
            '#3e999f',
            '#ffffff',
            '#000000',
            '#c82829',
            '#718c00',
            '#eab700',
            '#4271ae',
            '#8959a8',
            '#3e999f',
            '#ffffff',
        ],
    }

    static atomOneLightColorScheme: TerminalColorScheme = {
        name: 'AtomOneLight',
        foreground: '#2a2c33',
        background: '#f9f9f9',
        cursor: '#bbbbbb',
        colors: [
            '#000000',
            '#de3e35',
            '#3f953a',
            '#d2b67c',
            '#2f5af3',
            '#950095',
            '#3f953a',
            '#bbbbbb',
            '#000000',
            '#de3e35',
            '#3f953a',
            '#d2b67c',
            '#2f5af3',
            '#a00095',
            '#3f953a',
            '#ffffff',
        ],
    }

    async getSchemes (): Promise<TerminalColorScheme[]> {
        return [
            DefaultColorSchemes.defaultColorScheme,
            DefaultColorSchemes.defaultLightColorScheme,
        ]
    }
}
