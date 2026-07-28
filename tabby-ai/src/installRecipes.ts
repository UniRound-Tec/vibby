export type InstallPlatform = 'windows' | 'macos' | 'linux'

export interface CliInstallRecipe {
    /** Exact command shown to the user and executed after confirmation */
    command?: string

    /** Primary source for this installation command */
    sourceUrl: string

    /** Whether this environment can run the recipe directly */
    support: 'ready' | 'requires-wsl' | 'guided'

    /** Short prerequisite or platform caveat shown above the terminal */
    note?: string
}

/**
 * Kept separate from the detection registry: install support changes more
 * frequently than binary names, and a missing recipe must never hide a CLI.
 */
export const CLI_INSTALL_RECIPES: Readonly<Partial<Record<string, Partial<Record<InstallPlatform, CliInstallRecipe>>>>> = {
    'claude-code': {
        windows: {
            command: 'irm https://claude.ai/install.ps1 | iex',
            sourceUrl: 'https://code.claude.com/docs/en/installation',
            support: 'ready',
            note: 'Windows 10 1809 or newer. Git for Windows is recommended.',
        },
        macos: {
            command: 'curl -fsSL https://claude.ai/install.sh | bash',
            sourceUrl: 'https://code.claude.com/docs/en/installation',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://claude.ai/install.sh | bash',
            sourceUrl: 'https://code.claude.com/docs/en/installation',
            support: 'ready',
        },
    },
    codex: {
        windows: {
            command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
            sourceUrl: 'https://github.com/openai/codex/blob/main/README.md',
            support: 'ready',
        },
        macos: {
            command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
            sourceUrl: 'https://github.com/openai/codex/blob/main/README.md',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
            sourceUrl: 'https://github.com/openai/codex/blob/main/README.md',
            support: 'ready',
        },
    },
    opencode: {
        windows: {
            command: 'npm install -g opencode-ai',
            sourceUrl: 'https://opencode.ai/docs/',
            support: 'ready',
            note: 'Requires Node.js and npm. OpenCode recommends WSL for the best Windows compatibility.',
        },
        macos: {
            command: 'curl -fsSL https://opencode.ai/install | bash',
            sourceUrl: 'https://opencode.ai/docs/',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://opencode.ai/install | bash',
            sourceUrl: 'https://opencode.ai/docs/',
            support: 'ready',
        },
    },
    pi: {
        windows: {
            command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
            sourceUrl: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md',
            support: 'ready',
            note: 'Requires Node.js 22.19.0 or newer and npm. Bash from Git for Windows is needed by pi shell tools.',
        },
        macos: {
            command: 'curl -fsSL https://pi.dev/install.sh | sh',
            sourceUrl: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://pi.dev/install.sh | sh',
            sourceUrl: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md',
            support: 'ready',
        },
    },
    'github-copilot': {
        windows: {
            command: 'winget install GitHub.Copilot',
            sourceUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
            support: 'ready',
            note: 'WinGet may request source agreement or administrator approval.',
        },
        macos: {
            command: 'curl -fsSL https://gh.io/copilot-install | bash',
            sourceUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://gh.io/copilot-install | bash',
            sourceUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
            support: 'ready',
        },
    },
    'antigravity-cli': {
        windows: {
            command: 'irm https://antigravity.google/cli/install.ps1 | iex',
            sourceUrl: 'https://antigravity.google/docs/cli-getting-started',
            support: 'ready',
        },
        macos: {
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
            sourceUrl: 'https://antigravity.google/docs/cli-getting-started',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
            sourceUrl: 'https://antigravity.google/docs/cli-getting-started',
            support: 'ready',
        },
    },
    'cursor-agent': {
        windows: {
            sourceUrl: 'https://docs.cursor.com/en/cli/installation',
            support: 'requires-wsl',
            note: 'Cursor Agent CLI has no supported native Windows installer. Install it inside WSL.',
        },
        macos: {
            command: 'curl https://cursor.com/install -fsS | bash',
            sourceUrl: 'https://docs.cursor.com/en/cli/installation',
            support: 'ready',
        },
        linux: {
            command: 'curl https://cursor.com/install -fsS | bash',
            sourceUrl: 'https://docs.cursor.com/en/cli/installation',
            support: 'ready',
        },
    },
    cline: {
        windows: {
            command: 'npm install -g cline',
            sourceUrl: 'https://github.com/cline/cline/blob/main/apps/cli/README.md',
            support: 'ready',
            note: 'Requires Node.js 20 or newer; Node.js 22 is recommended.',
        },
        macos: {
            command: 'npm install -g cline',
            sourceUrl: 'https://github.com/cline/cline/blob/main/apps/cli/README.md',
            support: 'ready',
            note: 'Requires Node.js 20 or newer; Node.js 22 is recommended.',
        },
        linux: {
            command: 'npm install -g cline',
            sourceUrl: 'https://github.com/cline/cline/blob/main/apps/cli/README.md',
            support: 'ready',
            note: 'Requires Node.js 20 or newer; Node.js 22 is recommended.',
        },
    },
    'qwen-code': {
        windows: {
            command: 'irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex',
            sourceUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/',
            support: 'ready',
        },
        macos: {
            command: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
            sourceUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
            sourceUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/',
            support: 'ready',
        },
    },
    'kimi-code': {
        windows: {
            command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
            sourceUrl: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started.html',
            support: 'ready',
            note: 'Git for Windows is required before first launch.',
        },
        macos: {
            command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
            sourceUrl: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started.html',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
            sourceUrl: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started.html',
            support: 'ready',
        },
    },
    'grok-build': {
        windows: {
            command: 'irm https://x.ai/cli/install.ps1 | iex',
            sourceUrl: 'https://github.com/xai-org/grok-build',
            support: 'ready',
        },
        macos: {
            command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
            sourceUrl: 'https://github.com/xai-org/grok-build',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
            sourceUrl: 'https://github.com/xai-org/grok-build',
            support: 'ready',
        },
    },
    'kiro-cli': {
        windows: {
            command: 'irm \'https://cli.kiro.dev/install.ps1\' | iex',
            sourceUrl: 'https://kiro.dev/docs/cli/installation/',
            support: 'ready',
            note: 'The documented Windows CLI route requires Windows 11.',
        },
        macos: {
            command: 'curl -fsSL https://cli.kiro.dev/install | bash',
            sourceUrl: 'https://kiro.dev/docs/cli/installation/',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://cli.kiro.dev/install | bash',
            sourceUrl: 'https://kiro.dev/docs/cli/installation/',
            support: 'ready',
            note: 'If the installer rejects this architecture or libc, use the official artifact guide.',
        },
    },
    'kilo-code': {
        windows: {
            command: 'npm install -g @kilocode/cli',
            sourceUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
            support: 'ready',
            note: 'Requires Node.js and npm.',
        },
        macos: {
            command: 'npm install -g @kilocode/cli',
            sourceUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
            support: 'ready',
            note: 'Requires Node.js and npm.',
        },
        linux: {
            command: 'npm install -g @kilocode/cli',
            sourceUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
            support: 'ready',
            note: 'Requires Node.js and npm.',
        },
    },
    crush: {
        windows: {
            command: 'winget install charmbracelet.crush',
            sourceUrl: 'https://github.com/charmbracelet/crush',
            support: 'ready',
            note: 'WinGet may request source agreement or administrator approval.',
        },
        macos: {
            command: 'brew install charmbracelet/tap/crush',
            sourceUrl: 'https://github.com/charmbracelet/crush',
            support: 'ready',
            note: 'Requires Homebrew.',
        },
        linux: {
            command: 'npm install -g @charmland/crush',
            sourceUrl: 'https://github.com/charmbracelet/crush',
            support: 'ready',
            note: 'Requires Node.js and npm.',
        },
    },
    'factory-droid': {
        windows: {
            command: 'irm https://app.factory.ai/cli/windows | iex',
            sourceUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
            support: 'ready',
        },
        macos: {
            command: 'curl -fsSL https://app.factory.ai/cli | sh',
            sourceUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://app.factory.ai/cli | sh',
            sourceUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
            support: 'ready',
            note: 'Install xdg-utils first so browser authentication can open correctly.',
        },
    },
    'devin-cli': {
        windows: {
            command: 'irm https://static.devin.ai/cli/setup.ps1 | iex',
            sourceUrl: 'https://cli.devin.ai/reference/commands',
            support: 'ready',
            note: 'Requires eligible Devin Enterprise or Windsurf Enterprise access.',
        },
        macos: {
            command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
            sourceUrl: 'https://cli.devin.ai/reference/commands',
            support: 'ready',
            note: 'Requires eligible Devin Enterprise or Windsurf Enterprise access.',
        },
        linux: {
            command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
            sourceUrl: 'https://cli.devin.ai/reference/commands',
            support: 'ready',
            note: 'Requires eligible Devin Enterprise or Windsurf Enterprise access.',
        },
    },
    amp: {
        windows: {
            command: 'powershell -c "irm https://ampcode.com/install.ps1 | iex"',
            sourceUrl: 'https://ampcode.com/manual',
            support: 'ready',
            note: 'Amp recommends WSL for the best Windows compatibility.',
        },
        macos: {
            command: 'curl -fsSL https://ampcode.com/install.sh | bash',
            sourceUrl: 'https://ampcode.com/manual',
            support: 'ready',
        },
        linux: {
            command: 'curl -fsSL https://ampcode.com/install.sh | bash',
            sourceUrl: 'https://ampcode.com/manual',
            support: 'ready',
        },
    },
}

export function installPlatformFor (platform = process.platform): InstallPlatform|null {
    if (platform === 'win32') {
        return 'windows'
    }
    if (platform === 'darwin') {
        return 'macos'
    }
    if (platform === 'linux') {
        return 'linux'
    }
    return null
}

export function installRecipeFor (
    cliId: string,
    platform = installPlatformFor(),
): CliInstallRecipe|null {
    return platform ? CLI_INSTALL_RECIPES[cliId]?.[platform] ?? null : null
}

export function installPlatformForTarget (
    target: { platform: 'windows'|'macos'|'linux' }|null|undefined,
): InstallPlatform|null {
    return target?.platform ?? null
}

export function installShellCommand (
    recipe: CliInstallRecipe,
    platform = installPlatformFor(),
): { command: string, args: string[] } {
    if (!recipe.command || recipe.support !== 'ready') {
        throw new Error('This installation recipe cannot run automatically')
    }
    if (platform === 'windows') {
        const script = [
            '$ErrorActionPreference = \'Stop\'',
            recipe.command,
            'if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ].join('; ')
        return {
            command: 'powershell.exe',
            args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${script} }`],
        }
    }
    return {
        command: '/bin/sh',
        args: ['-lc', recipe.command],
    }
}

const YARN_LIFECYCLE_ENV_KEYS = new Set([
    'npm_config_argv',
    'npm_config_version_commit_hooks',
    'npm_config_version_git_message',
    'npm_config_version_git_sign',
    'npm_config_version_git_tag',
    'npm_config_version_tag_prefix',
])

/** Environment inherited by the installer shell. */
export function installShellEnvironment (
    environment: Record<string, string|undefined>,
    platform = installPlatformFor(),
): Record<string, string|undefined> {
    return Object.fromEntries(
        Object.entries(environment).filter(([key]) => {
            const normalized = key.toLowerCase()
            return !YARN_LIFECYCLE_ENV_KEYS.has(normalized) &&
                (platform !== 'windows' || normalized !== 'psmodulepath')
        }),
    )
}
