# AI coding CLI ecosystem snapshot

Date: 2026-07-27

## Executive summary

Vibby should not treat every visible vendor name as proof of broad CLI adoption. Public CLI-specific usage counts are rare, so this report uses a combination of:

- official product status and migration announcements;
- repository activity and GitHub stars as a rough interest signal;
- whether the CLI is the project's primary product or a newly added surface;
- the availability of stable hooks, ACP, streaming JSON, SDKs, or local event APIs.

The highest-value additions are GitHub Copilot CLI, Antigravity CLI, Cursor Agent CLI, Cline CLI, Qwen Code, Goose, Kimi Code, Grok Build, and Kiro CLI.

The most urgent correction is Google: Gemini CLI has transitioned to Antigravity CLI. Google said Gemini CLI had millions of users, but consumer Gemini CLI service stopped on 2026-06-18 in favor of Antigravity CLI. Vibby should retain Gemini only as a legacy detector and add `agy` as the current Google CLI.

The three products raised by the user need different labels:

- Kimi Code is current and integration-friendly, but the new repository is still young. The older `MoonshotAI/kimi-cli` is being wound down.
- Grok Build drew unusually high open-source attention immediately after launch, but it is too new to call broadly adopted based on real usage.
- Devin CLI is strategically relevant and has a rich ACP surface, but access is plan/enterprise dependent, so it is not a broadly available public CLI.

## Recommended backlog

### P0 — add or correct now

| CLI | Binary | Public adoption signal | Monitoring surface | Vibby recommendation |
| --- | --- | --- | --- | --- |
| GitHub Copilot CLI | `copilot` | 11,025 GitHub stars; backed by the much larger Copilot installed base | Lifecycle hooks cover session, tool, permission, notification, agent and subagent events | Full monitor |
| Google Antigravity CLI | `agy` | Official successor to Gemini CLI; Google cited millions of Gemini CLI users | Hooks and shared Antigravity agent engine; headless print mode | Full monitor; keep `gemini` as legacy |
| Cursor Agent CLI | `cursor-agent` | Cursor is widely used, but CLI-specific usage is not public and the CLI is still labeled beta | `stream-json` emits session, text and tool events only in print mode; thinking is explicitly suppressed | Launch support first; full status only for headless mode |
| Cline CLI | `cline` | Cline project: 65,091 stars; CLI is newer than the IDE extension | Rich lifecycle hooks, NDJSON output, ACP and local hub | Full monitor |
| Qwen Code | `qwen` | 26,351 stars; active open-source terminal-first project | Command and HTTP hooks across session, tool, permission, notification, stop and subagent events; ACP | Full monitor |
| Goose | `goose` | 51,759 stars; established terminal-first open-source agent | ACP and a client/server event stream are available | Full monitor, validate server stability |
| Kimi Code | `kimi` | New repo: 5,220 stars; old repo: 10,906 stars and being wound down | Rich lifecycle hooks and `kimi acp` | Full monitor; do not target old `kimi-cli` internals |
| Grok Build | `grok` | 22,803 stars within roughly two weeks of repository creation; high attention, not proven broad usage | Lifecycle hooks, streaming JSON and `grok agent stdio` ACP | Full monitor |
| Kiro CLI | `kiro-cli` | AWS replaced Amazon Q CLI with Kiro CLI; CLI-specific usage is not public | JSON lifecycle hooks include session, prompt, tool and stop events | Full monitor; replace Amazon Q alias |

### P1 — valuable next wave

| CLI | Binary | Public adoption signal | Monitoring surface | Vibby recommendation |
| --- | --- | --- | --- | --- |
| Kilo Code CLI | `kilo` | Kilo project: 26,535 stars; CLI 1.x is newer than the project | OpenCode at its core, plus sessions, daemon and remote relay | Likely reuse the OpenCode adapter |
| Crush | `crush` | 26,871 stars; active terminal-first project | Experimental client/server architecture with SSE; logs and notifications | Full monitor after protocol validation |
| OpenHands CLI | `openhands` | OpenHands project: 82,211 stars; CLI is one of several product surfaces | ACP, headless mode and SDK; heavier local runtime, WSL required on Windows | Full monitor, but higher implementation cost |
| Factory Droid | `droid` | Commercial adoption is not public | Broad hooks plus a streaming Droid Exec SDK | Full monitor |
| Devin CLI | `devin` | Commercial/enterprise adoption is not public; availability is gated | Rich ACP methods and streamed shell/session state | Full monitor for eligible customers |
| Continue CLI | `cn` | Continue project: 35,126 stars; CLI is newer than its IDE extensions | TUI and headless mode; verify stable event API before promising full coverage | Launch, then protocol spike |
| Amp | `amp` | Proprietary usage is not public | `--stream-json` exists for execute mode | Launch plus headless monitoring |

### P2 — watch, do not market as broadly used yet

- Mistral Vibe (`vibe`)
- iFlow CLI (`iflow`)
- Qoder CLI (`qodercli`)
- Tencent CodeBuddy CLI (`codebuddy`)

These are active vendor-backed products and may matter in particular regions, but comparable CLI adoption evidence is currently weak or private. Add launch detection when cheap; defer custom full-monitor adapters until demand is visible.

## Important product corrections

### Gemini CLI is now legacy for consumers

Google's official 2026-05-19 announcement says Antigravity CLI replaces Gemini CLI for consumer use, with service ending on 2026-06-18 for free users and Google AI Pro/Ultra users. The new binary is `agy`.

Registry behavior should be:

1. detect and label `agy` as Google Antigravity CLI;
2. keep `gemini` as a legacy compatibility entry, not the current Google recommendation;
3. avoid investing in a new Gemini-specific full adapter unless enterprise Gemini compatibility requires it.

### Kimi has two generations

The current project is `MoonshotAI/kimi-code`, installed and launched as `kimi`. The older `MoonshotAI/kimi-cli` repository explicitly says it will be gradually wound down and that Kimi Code migrates existing configuration and sessions.

### Amazon Q CLI became Kiro CLI

AWS documentation states that Q CLI became Kiro CLI. Prefer `kiro-cli` in the registry and treat old Q command names as compatibility aliases only.

### Aider is historical coverage

Aider still has a large historical footprint, but its maintenance cadence and current strategic relevance are lower than the P0/P1 products above. If registry space or QA capacity is limited, remove Aider before excluding Copilot, Antigravity, Cline, Qwen, Goose, Kimi, or Grok.

## Monitoring architecture implications

The current ecosystem is converging on three integration families:

1. **Lifecycle hooks** — Copilot, Cline, Qwen, Kimi, Grok, Kiro and Droid expose structured session/tool/permission/stop events. A shared hook adapter can normalize most of them.
2. **ACP over stdio** — Cline, Qwen, Kimi, Grok, OpenHands and Devin expose ACP. A shared ACP client can provide the deepest long-term integration, but Vibby must decide whether it is observing a user's native TUI session or launching the agent through ACP.
3. **Streaming/headless output** — Cursor, Grok, Cline and Amp expose NDJSON or streaming JSON. This is reliable for Vibby-launched headless runs but often does not observe a normal interactive TUI.

Do not infer `thinking` from generic activity. A provider must expose a specific reasoning/thinking signal; otherwise Vibby should show `working`. Cursor's official stream documentation explicitly says thinking events are suppressed in print mode, so Cursor cannot truthfully provide a `thinking` state through that interface.

## Evidence caveats

GitHub counts were read from the official repositories on 2026-07-27. They are directional, not active-user counts. For Cline, OpenHands, Kilo and Continue, the repository covers more than the CLI, so the number overstates CLI-specific adoption. For proprietary products such as Cursor, Devin, Droid, Amp and Kiro, no comparable public CLI usage figure was found.

Grok Build is the clearest example of why stars and use must be separated: its repository reached 22,803 stars very quickly, but it was created on 2026-07-14. That proves strong attention, not mature daily adoption.

## Primary sources

- [Google: Transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- [Antigravity CLI repository](https://github.com/google-antigravity/antigravity-cli)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [GitHub Copilot CLI repository](https://github.com/github/copilot-cli)
- [Cursor CLI overview](https://docs.cursor.com/en/cli/overview)
- [Cursor stream JSON format](https://docs.cursor.com/en/cli/reference/output-format)
- [Cline CLI overview](https://docs.cline.bot/usage/cli-overview)
- [Cline hooks](https://docs.cline.bot/customization/hooks)
- [Qwen Code repository](https://github.com/QwenLM/qwen-code)
- [Qwen Code hooks](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md)
- [Goose repository](https://github.com/aaif-goose/goose)
- [Kimi Code repository](https://github.com/MoonshotAI/kimi-code)
- [Kimi Code hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks)
- [Legacy Kimi CLI repository](https://github.com/MoonshotAI/kimi-cli)
- [Grok Build overview](https://docs.x.ai/build/overview)
- [Grok Build CLI reference](https://docs.x.ai/build/cli/reference)
- [Kiro CLI overview](https://kiro.dev/docs/cli/)
- [Kiro CLI hooks](https://kiro.dev/docs/cli/hooks/)
- [AWS: Q CLI became Kiro CLI](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html)
- [Kilo Code CLI](https://kilo.ai/docs/code-with-ai/platforms/cli)
- [Crush repository](https://github.com/charmbracelet/crush)
- [OpenHands CLI quick start](https://docs.openhands.dev/openhands/usage/cli/quick-start)
- [Factory Droid hooks](https://docs.factory.ai/cli/configuration/hooks-guide)
- [Devin for Terminal](https://cli.devin.ai/reference/commands)
- [Devin 2026 release notes](https://docs.devin.ai/release-notes/2026)
- [Continue CLI quick start](https://docs.continue.dev/cli/quickstart)
- [Amp manual](https://ampcode.com/manual)
