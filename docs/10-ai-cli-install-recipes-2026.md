# AI CLI installation recipes for an embedded terminal

Date: 2026-07-27

## Decision summary

The proposed interaction is viable: an unavailable (grey) CLI card can open a modal containing an embedded terminal, show the exact platform-specific command, and let the user run the installer interactively.

It must not be modelled as “every CLI has one command for every OS.” Recipe selection needs at least `{platform, architecture, shell, prerequisites}` and the registry needs three outcomes per execution environment:

- `ready`: Vibby has a first-party command suitable for the selected shell.
- `requires-wsl`: the vendor supports the CLI on Windows only through WSL; Vibby must launch a WSL terminal profile.
- `guided`: the official installation is a download or multi-step flow, so Vibby should open the official instructions rather than improvise a shell command.

The install terminal must be genuinely interactive. Password, UAC, package-source agreement, PATH, browser/device authentication, and first-run configuration prompts must remain under user control.

## Recommended UX and execution contract

1. Clicking an unavailable card opens an install modal; it must not immediately execute remote code.
2. The modal shows:
   - detected platform and actual shell (`PowerShell`, `cmd`, POSIX shell, or WSL);
   - the exact command and its first-party source;
   - prerequisites and whether the CLI is legacy, gated, or WSL-only;
   - an explicit **Run installation** action.
3. Commands are static, reviewed registry data. Never compose an installer URL or package name from UI text.
4. Run the command inside the embedded PTY so password and installer prompts work. Do not append `--yes`, auto-answer prompts, or hide output unless the vendor's documented command already does so.
5. Do not automatically start the newly installed agent. Authentication and workspace trust often belong to first launch and should happen when the user intentionally opens the CLI.
6. On installer exit, run the registry's existing version probe in a **new shell process**. Installers frequently change PATH only for new processes. If it is still missing, show “restart terminal/app and rescan,” not a false failure.
7. A zero exit code plus a failed version probe is `installed-unverified`, not `installed`.
8. Closing the modal should terminate only the installer PTY process tree after confirmation; it must not kill unrelated terminals.

Suggested data shape:

```ts
type InstallRecipe = {
    platform: 'win32' | 'darwin' | 'linux' | 'wsl'
    architecture: 'x64' | 'arm64' | 'any'
    shell: 'powershell' | 'cmd' | 'posix'
    command: string
    prerequisites?: string[]
    support: 'ready' | 'requires-wsl' | 'guided'
    note?: string
    sourceUrl: string
}
```

WSL is an execution target, not merely a note attached to `win32`. A native Windows card and a WSL-installed binary live in different environments and may be discovered differently.

## Reviewed recipes

Commands below are installation commands only. “First-run interaction” describes what the user is likely to encounter after installation, not something Vibby should automate.

### Claude Code (`claude`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm https://claude.ai/install.ps1 \| iex` |
| macOS / Linux / WSL | `curl -fsSL https://claude.ai/install.sh \| bash` |

- Support: `ready`.
- Prerequisites: Windows 10 1809+ or supported macOS/Linux; Git for Windows is recommended for native Windows Bash-tool support.
- Interaction: the installer itself is normally unattended. First launch opens browser authentication; a paid Claude/Console-supported account or supported third-party provider is required.
- Source: [Claude Code advanced setup and installation](https://code.claude.com/docs/en/installation).

### Codex CLI (`codex`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` |
| macOS / Linux / WSL | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Fallback, all platforms | `npm install -g @openai/codex` |

- Support: `ready`.
- Prerequisites: no Node.js prerequisite for the native installer; npm fallback requires Node/npm.
- Interaction: first launch asks the user to authenticate with ChatGPT or configure API credentials.
- Source: [OpenAI Codex repository quickstart](https://github.com/openai/codex/blob/main/README.md).

### Gemini CLI (`gemini`) — legacy

| Target | Recipe |
| --- | --- |
| Windows / macOS / Linux / WSL | `npm install -g @google/gemini-cli` |

- Support: technically `ready`, but Vibby should label this as a legacy choice and recommend Antigravity CLI.
- Prerequisites: Node.js 20+ and npm.
- Interaction: first launch asks the user to select and complete an authentication method.
- Source: [Gemini CLI repository installation](https://github.com/google-gemini/gemini-cli/blob/main/README.md) and [Google's Gemini-to-Antigravity transition notice](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).

### OpenCode (`opencode`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `npm install -g opencode-ai` |
| macOS / Linux / WSL | `curl -fsSL https://opencode.ai/install \| bash` |

- Support: `ready`. Windows can alternatively use `choco install opencode` or `scoop install opencode`.
- Prerequisites: npm recipe requires Node/npm; the vendor recommends WSL for the best Windows compatibility.
- Interaction: first launch requires provider configuration; `/connect` asks the user to select a provider and enter credentials.
- Source: [OpenCode installation](https://opencode.ai/docs/).

### pi (`pi`)

| Target | Recipe |
| --- | --- |
| Windows / macOS / Linux / WSL | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` |
| macOS / Linux / WSL alternative | `curl -fsSL https://pi.dev/install.sh \| sh` |

- Support: `ready`.
- Prerequisites: Node.js and npm for the npm route. On Windows, pi's shell tools require Bash, normally from Git for Windows.
- Interaction: first launch needs an API key or the interactive `/login` provider flow.
- Source: [Current pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

The package was renamed from `@mariozechner/pi-coding-agent`; Vibby's runtime markers should include the current `@earendil-works/pi-coding-agent` name.

### GitHub Copilot CLI (`copilot`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `winget install GitHub.Copilot` |
| macOS / Linux / WSL | `curl -fsSL https://gh.io/copilot-install \| bash` |
| Fallback, all platforms | `npm install -g @github/copilot` |

- Support: `ready`.
- Prerequisites: Windows PowerShell 6+ for supported Windows use; npm path requires Node.js 22+.
- Interaction: WinGet may ask for source agreement or UAC. `copilot login` starts an OAuth device flow and requires a Copilot-enabled account unless the user configures BYOK.
- Source: [Installing GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) and [authenticating Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).

### Antigravity CLI (`agy`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Windows / CMD | `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd` |
| macOS / Linux / WSL | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |

- Support: `ready`.
- Prerequisites: no additional runtime is documented for the native installer.
- Interaction: first launch asks for color scheme, rendering mode, workspace trust, and may offer interactive migration from Gemini CLI.
- Source: [Antigravity CLI getting started](https://antigravity.google/docs/cli-getting-started).

### Cursor Agent CLI (`cursor-agent`)

| Target | Recipe |
| --- | --- |
| macOS / Linux / WSL | `curl https://cursor.com/install -fsS \| bash` |
| Native Windows | No supported first-party native recipe |

- Support: `ready` on macOS/Linux; `requires-wsl` on Windows.
- Prerequisites: `curl`; the installer places the binary under `~/.local/bin`, which may need to be added to PATH.
- Interaction: `cursor-agent login` opens browser authentication. Normal agent use asks for command approvals.
- Source: [Cursor CLI installation](https://docs.cursor.com/en/cli/installation) and [authentication](https://docs.cursor.com/en/cli/reference/authentication).

### Cline CLI (`cline`)

| Target | Recipe |
| --- | --- |
| Windows / macOS / Linux / WSL | `npm install -g cline` |

- Support: `ready`.
- Prerequisites: Node.js 20+ (22 recommended) and npm.
- Interaction: `cline auth` opens an interactive provider selection; OAuth options can open a browser, while API-key options ask for credentials.
- Source: [Installing Cline](https://docs.cline.bot/getting-started/installing-cline) and [Cline CLI README](https://github.com/cline/cline/blob/main/apps/cli/README.md).

### Qwen Code (`qwen`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 \| iex` |
| macOS / Linux / WSL | `curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh \| bash` |
| Fallback, all platforms | `npm install -g @qwen-code/qwen-code@latest` |

- Support: `ready`.
- Prerequisites: no Node runtime for the standalone installer; npm fallback requires Node.js 22+.
- Interaction: first launch asks the user to select a model provider and enter an API key.
- Source: [Qwen Code quickstart](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/) and [deployment guide](https://qwenlm.github.io/qwen-code-docs/en/developers/development/deployment/).

### Goose (`goose`)

| Target | Recipe |
| --- | --- |
| macOS / Linux / WSL | `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh \| bash` |
| Windows / Git Bash or MSYS2 | Same installer script; Windows x64 only |
| Windows / PowerShell | Do not run the Bash installer directly; choose a Git Bash/WSL terminal or use official release assets |

- Support: `ready` on macOS/Linux/WSL and Windows x64 when Vibby can open Git Bash/MSYS2; otherwise `guided` on native PowerShell.
- Prerequisites: POSIX-compatible shell and `curl`; the installer supports Windows only through its MSYS/Git Bash path and only on x64.
- Interaction: the official installer normally enters `goose configure` at the end, so the install PTY must stay interactive for provider/model and credential setup.
- Source: [Goose official repository](https://github.com/aaif-goose/goose).

Do not send this Bash pipeline to PowerShell and do not silently substitute a community Chocolatey/Scoop package. If Vibby later implements official release-asset installation, it must verify architecture and published checksums.

### Kimi Code (`kimi`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm https://code.kimi.com/kimi-code/install.ps1 \| iex` |
| macOS / Linux / WSL | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` |

- Support: `ready`.
- Prerequisites: Git for Windows is required before first launch on native Windows; the npm alternative requires Node.js 22.19+.
- Interaction: first launch uses `/login`, then asks between Kimi OAuth device flow and an API key. Write and shell operations ask for confirmation by default.
- Source: [Kimi Code getting started](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html).

### Grok Build (`grok`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm https://x.ai/cli/install.ps1 \| iex` |
| macOS / Linux / WSL | `curl -fsSL https://x.ai/cli/install.sh \| bash` |

- Support: `ready`.
- Prerequisites: none documented for prebuilt releases.
- Interaction: first launch opens browser authentication. A device-code flow is available later via `grok login --device-auth`.
- Source: [Grok Build official repository](https://github.com/xai-org/grok-build) and [authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md).

### Kiro CLI (`kiro-cli`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm 'https://cli.kiro.dev/install.ps1' \| iex` |
| macOS / supported Linux | `curl -fsSL https://cli.kiro.dev/install \| bash` |
| Linux fallback | Official AppImage, `.deb`, or architecture/glibc-specific zip flow |

- Support: `ready` on Windows/macOS and supported Linux systems; `guided` when the Linux installer rejects the host.
- Prerequisites: Windows 11 for the documented Windows CLI route. Linux requires the correct x86_64/aarch64 and glibc/musl artifact; standard builds require glibc 2.34+.
- Interaction: after installation Kiro directs the user to a browser for authentication.
- Source: [Kiro CLI installation](https://kiro.dev/docs/cli/installation/).

Vibby should not guess the Linux asset. A later helper may safely select it only after architecture and glibc detection are implemented and tested.

### Kilo Code CLI (`kilo`)

| Target | Recipe |
| --- | --- |
| Windows / macOS / Linux / WSL | `npm install -g @kilocode/cli` |

- Support: `ready`.
- Prerequisites: Node/npm; older non-AVX CPUs require a platform-specific baseline binary from releases instead.
- Interaction: first launch uses `/connect` to select a provider and enter credentials.
- Source: [Kilo Code CLI documentation](https://kilo.ai/docs/code-with-ai/platforms/cli).

### Crush (`crush`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `winget install charmbracelet.crush` |
| macOS | `brew install charmbracelet/tap/crush` |
| Linux / WSL fallback | `npm install -g @charmland/crush` |

- Support: `ready`, conditional on the listed package manager. The npm recipe is also cross-platform when npm is present.
- Prerequisites: WinGet, Homebrew, or Node/npm according to recipe.
- Interaction: WinGet may prompt for source agreements or UAC. First launch asks the user to select a provider/model and authenticate or paste an API key.
- Source: [Crush official repository installation](https://github.com/charmbracelet/crush).

### OpenHands CLI (`openhands`)

| Target | Recipe |
| --- | --- |
| macOS / Linux / WSL | `curl -fsSL https://install.openhands.dev/install.sh \| sh` |
| Alternative with uv | `uv tool install openhands --python 3.12` |
| Native Windows | Unsupported |

- Support: `ready` on macOS/Linux; `requires-wsl` on Windows.
- Prerequisites: the uv route requires Python 3.12+ and uv. Windows commands must run inside an Ubuntu WSL terminal.
- Interaction: first run asks for required LLM settings; `openhands login` authenticates with OpenHands Cloud.
- Source: [OpenHands CLI installation](https://docs.openhands.dev/openhands/usage/cli/installation) and [quick start](https://docs.openhands.dev/openhands/usage/cli/quick-start).

### Factory Droid (`droid`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm https://app.factory.ai/cli/windows \| iex` |
| macOS / Linux / WSL | `curl -fsSL https://app.factory.ai/cli \| sh` |
| Fallback, all platforms | `npm install -g droid` |

- Support: `ready`.
- Prerequisites: Linux users need `xdg-utils` for proper browser-opening behavior; npm fallback requires Node/npm.
- Interaction: first run may open browser sign-in. Changes and higher-impact actions remain approval-driven according to the selected autonomy mode.
- Source: [Factory official repository](https://github.com/Factory-AI/factory) and [Droid quickstart](https://docs.factory.ai/cli/getting-started/quickstart).

### Devin CLI (`devin`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm https://static.devin.ai/cli/setup.ps1 \| iex` |
| macOS / Linux / WSL | `curl -fsSL https://cli.devin.ai/install.sh \| bash` |

- Support: `ready`, but access-gated. The vendor recommends WSL on Windows when possible.
- Prerequisites: Devin Enterprise or Windsurf Enterprise access enabled by an administrator.
- Interaction: entitlement/authentication is required; installation cannot make an ineligible account usable.
- Source: [Devin for Terminal quickstart](https://cli.devin.ai/reference/commands).

The card must say “Requires eligible enterprise access” before execution.

### Continue CLI (`cn`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `irm https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/scripts/install.ps1 \| iex` |
| macOS / Linux / WSL | `curl -fsSL https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/scripts/install.sh \| bash` |
| Fallback, all platforms | `npm install -g @continuedev/cli` |

- Support: `ready`.
- Prerequisites: native scripts bundle their own runtime; npm route requires Node.js 20+.
- Interaction: first launch asks the user to log in with Continue or enter an Anthropic API key.
- Source: [Continue official repository](https://github.com/continuedev/continue/blob/main/README.md) and [CLI quickstart](https://docs.continue.dev/cli/quickstart).

### Amp (`amp`)

| Target | Recipe |
| --- | --- |
| Windows / PowerShell | `powershell -c "irm https://ampcode.com/install.ps1 \| iex"` |
| macOS / Linux / WSL | `curl -fsSL https://ampcode.com/install.sh \| bash` |

- Support: `ready`; Amp's manual says Windows is supported via WSL while also publishing a Windows PowerShell installer. Vibby should surface the vendor's WSL recommendation instead of claiming full native parity.
- Prerequisites: an Amp account; npm installation exists but is explicitly not recommended.
- Interaction: sign-in is required before normal use.
- Source: [Amp owner's manual](https://ampcode.com/manual).

## Platform coverage matrix

| CLI | Windows native | WSL | macOS | Linux | Important condition |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Ready | Ready | Ready | Ready | Git for Windows recommended |
| Codex CLI | Ready | Ready | Ready | Ready | Native installer preferred |
| Gemini CLI | Ready | Ready | Ready | Ready | Legacy; Node 20+ |
| OpenCode | Ready | Ready | Ready | Ready | WSL recommended on Windows |
| pi | Ready | Ready | Ready | Ready | Current package is `@earendil-works/*`; Bash needed on Windows |
| GitHub Copilot CLI | Ready | Ready | Ready | Ready | Copilot/BYOK; Node 22+ for npm |
| Antigravity CLI | Ready | Ready | Ready | Ready | First-run setup |
| Cursor Agent CLI | No | Ready | Ready | Ready | Windows requires WSL |
| Cline CLI | Ready | Ready | Ready | Ready | npm required for install |
| Qwen Code | Ready | Ready | Ready | Ready | Standalone installer preferred; Node 22+ for npm |
| Goose | Conditional | Ready | Ready | Ready | Windows x64 requires Git Bash/MSYS2 or WSL |
| Kimi Code | Ready | Ready | Ready | Ready | Git for Windows |
| Grok Build | Ready | Ready | Ready | Ready | Browser/device authentication |
| Kiro CLI | Ready | Ready | Ready | Ready/Guided | Installer first; artifact selection fallback |
| Kilo Code CLI | Ready | Ready | Ready | Ready | Baseline build on old CPUs |
| Crush | Ready | Ready | Ready | Ready | Package-manager dependent |
| OpenHands CLI | No | Ready | Ready | Ready | Windows requires WSL |
| Factory Droid | Ready | Ready | Ready | Ready | `xdg-utils` on Linux |
| Devin CLI | Ready | Ready | Ready | Ready | Enterprise entitlement |
| Continue CLI | Ready | Ready | Ready | Ready | Node 20+ only for npm route |
| Amp | Conditional | Ready | Ready | Ready | Vendor recommends WSL on Windows |

## Implementation implications

- The install button should be disabled only when no recipe exists for the **active execution environment**, not merely because the host OS is Windows.
- For `requires-wsl`, offer “Install in WSL” only when a WSL profile is available. Otherwise show the prerequisite and link to official docs.
- For `guided`, replace **Run installation** with **Open official instructions**.
- Detect prerequisites before opening the PTY where possible (`npm`, `winget`, `brew`, `curl`, WSL distro, CPU architecture, glibc). Missing prerequisites should produce a precise explanation, never an attempted fallback from an untrusted source.
- Store alternative recipes, but choose one deterministic preferred route. Suggested preference:
  1. vendor native installer;
  2. official OS package manager;
  3. official npm package;
  4. guided official release download.
- Remote pipeline commands (`curl | sh`, `irm | iex`) execute mutable network content. Display the source host and command, require the explicit confirmation, and never run them on card hover, page load, or rescan.
- Installation success and CLI readiness are separate. Authentication, organization policy, billing, API keys, provider selection, workspace trust, and WSL boundary issues may remain after a successful install.

The recipe review also found two registry maintenance items that should accompany a later implementation:

- pi's current npm runtime marker is `@earendil-works/pi-coding-agent`, replacing the older `@mariozechner/pi-coding-agent`.
- Amp's current npm fallback package is `@ampcode/cli`; `ampcode` alone is less precise as a process marker.

## Primary-source caveats

- Commands and platform support were checked against vendor documentation and first-party repositories on 2026-07-27. Installer URLs and prerequisites are product APIs and should be treated as versioned registry data.
- “Cross-platform npm package” means the package is published for those systems; it does not mean npm is already present or global installs are permission-free.
- GitHub stars and popularity are irrelevant to installer safety. Vibby should ship only reviewed first-party recipes, even if a community package manager offers another convenient package.
