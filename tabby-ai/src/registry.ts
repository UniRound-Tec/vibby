import { AiCliRegistryEntry } from './api'

const VERSION = /(\d+\.\d+\.\d+\S*)/

export const AI_CLI_REGISTRY: AiCliRegistryEntry[] = [
    {
        id: 'claude-code',
        name: 'Claude Code',
        binaries: ['claude'],
        runtimeMarkers: ['@anthropic-ai/claude-code'],
        versionArgs: ['--version'],
        versionPattern: VERSION,
        icon: require('./icons/claude-code.svg'),
        tier: 'full',
        docsUrl: 'https://code.claude.com/docs',
    },
    {
        id: 'codex',
        name: 'Codex CLI',
        binaries: ['codex'],
        runtimeMarkers: ['@openai/codex'],
        versionArgs: ['--version'],
        versionPattern: VERSION,
        icon: require('./icons/codex.svg'),
        tier: 'launch',
        docsUrl: 'https://github.com/openai/codex',
    },
    {
        id: 'gemini-cli',
        name: 'Gemini CLI',
        binaries: ['gemini'],
        runtimeMarkers: ['@google/gemini-cli'],
        versionArgs: ['--version'],
        versionPattern: VERSION,
        icon: require('./icons/gemini-cli.svg'),
        tier: 'launch',
        docsUrl: 'https://github.com/google-gemini/gemini-cli',
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        binaries: ['opencode'],
        runtimeMarkers: ['opencode-ai/', 'opencode/bin'],
        versionArgs: ['--version'],
        versionPattern: VERSION,
        icon: require('./icons/opencode.svg'),
        tier: 'launch',
        docsUrl: 'https://opencode.ai',
    },
    {
        id: 'aider',
        name: 'Aider',
        binaries: ['aider'],
        runtimeMarkers: ['aider_chat', 'aider-chat'],
        versionArgs: ['--version'],
        versionPattern: VERSION,
        icon: require('./icons/aider.svg'),
        tier: 'launch',
        docsUrl: 'https://aider.chat',
    },
    {
        // two letters, and a word that turns up in ordinary arguments — this
        // one leans on the marker and on being the process itself, never on a
        // bare token (see cliMatch.looksInvoked)
        id: 'pi',
        name: 'pi',
        binaries: ['pi'],
        versionArgs: ['--version'],
        versionPattern: VERSION,
        icon: require('./icons/pi.svg'),
        tier: 'launch',
    },
]
