# Agent notes (Vibby)

## WSL CLI launch and `#!/usr/bin/env node`

WSL Dashboard / profile launches use `wsl.exe … --exec <cli>`, which **does not** run a login/interactive shell. nvm / mise / asdf PATH from `.bashrc` is therefore missing.

Many npm-installed CLIs (notably Codex, Pi; also Claude / Kimi / OpenCode if installed via `npm i -g`) start with `#!/usr/bin/env node`. Without login PATH, that resolves to a stale system Node (often Node 12), while the script path still shows under `~/.nvm/versions/node/v22…`. Symptom:

```text
SyntaxError: Unexpected reserved word
    at Loader.moduleStrategy (internal/modules/esm/translators.js:…)
```

### Required pattern

1. Scan with `-i -l` and capture `$PATH` onto `WslCliRuntimeTarget.shellPath` (see `cliScanner.service.ts`).
2. Launch via `wslLaunchCommand`, which wraps as:

   ```text
   wsl.exe … --exec /usr/bin/env PATH=<shellPath> <cli> [args…]
   ```

3. When injecting CLI-only args after `--exec`, use `wslExecProgramIndex` so the insert point is the **real** CLI, not `/usr/bin/env`.

Do **not**:

- Rely on Windows `env.PATH` for WSL `--exec` (it does not become Linux `$PATH`).
- Reintroduce bare `--exec <absolute-nvm-cli>` without the env PATH wrapper.
- Switch launches to `bash -lc '…'` string-splicing for user paths (conflicts with the argv / inject design).

Native (macOS/Linux) GUI launches already inject login PATH via `profiles.ts` (`scanner.shellPath`). Keep WSL and native aligned in spirit.

### After changing this path

Saved sessions may still carry old argv. Users need a **rescan** or a **new** WSL CLI session for the wrap to take effect.
