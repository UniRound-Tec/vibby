# M1 实现规格：能扫能开（rev.2）

> 依据：`03-ai-terminal-design.md`（D1–D7 + §2.5 UI 定稿）｜ rev.2 2026-07-24：吸收 12 条代码级审查意见（P0×1 / P1×8 / P2×3），关键改动：会话发现改为递归 pane 遍历、启动协调改为纯 CLIHandler 短路（放弃默认值覆盖）、Welcome 纳入方案、Windows shim 平台化启动、Dashboard 取消恢复机制、热键补全 Config 契约。
> 目标：CLI 注册表 + 扫描器 + Profile 集成 + Dashboard 骨架（V3 值机看板）。无事件监听（M2）、无硬件（M3）。

## 1. 范围

**做**：
- 新插件包 `tabby-ai`（显示名 "vibby AI"）
- 已知 AI CLI 注册表（数据驱动）+ 扫描器 + 设置页（重扫/补充路径/隐藏条目）
- `AiCliProfileProvider`：扫描结果 → 内置 profile，进"配置与连接"选择器
- Dashboard 标签页（V3 看板）：板头计数、会话区（M1 全部"未监听"行）、CLI 站台条、空状态
- 启动协调：干净启动只落 Dashboard（不开默认终端、不开 Welcome）；关闭全部标签自动重开
- 工具栏 home 按钮 + `toggle-dashboard` 热键（含完整 Config 契约）

**不做（明确出界）**：
- 事件模型/适配器/状态动效（M2）
- 硬件通道（M3）
- **profile 变体编辑界面 → M1.5**：M1 只保证内置 profile 可选可启动；参数/cwd 编辑需要薄设置组件（可复用 tabby-local 公开导出的 `CommandLineEditorComponent`/`EnvironmentEditorComponent`），与"默认编辑器无此控件"的现实一致（审查 #7）
- 标签栏内嵌 pinned home 图标（需改上游 appRoot；M1 用工具栏按钮）
- Dashboard tab 恢复（审查 #8：无状态 tab 不出恢复令牌，`getRecoveryToken` 保持默认 null；单实例由启动协调统一保证，避免"恢复 vs openOnStart"异步竞态查重）

## 2. 包结构

```
tabby-ai/
├── package.json / tsconfig.json / webpack.config.mjs   # 照抄 tabby-linkifier 样板
└── src/
    ├── index.ts              # NgModule + DI 注册 + hotkey$ 订阅（§8）
    ├── api.ts                # AiCliRegistryEntry / DetectedCli / AiCliProfile
    ├── registry.ts           # 静态注册表
    ├── services/
    │   ├── cliScanner.service.ts     # BehaviorSubject 语义（§4）
    │   └── dashboard.service.ts      # 打开/聚焦/会话发现（§7）
    ├── profiles.ts           # AiCliProfileProvider（§5）
    ├── components/
    │   ├── dashboardTab.component.ts|pug|scss
    │   ├── cliChip.component.ts|pug|scss
    │   └── aiSettingsTab.component.ts|pug        # 设置页（§4）
    ├── settings.ts           # SettingsTabProvider
    ├── buttonProvider.ts     # 工具栏 home 按钮
    ├── hotkeys.ts            # HotkeyProvider（描述）——默认键值在 config.ts（§6）
    ├── cli.ts                # OpenDashboardCLIHandler（§7）
    ├── config.ts             # ConfigProvider：aiCli.* + hotkeys.*
    └── icons/                # lobe-icons SVG 内嵌（Aider 字母占位；保留许可注释）
```

## 3. CLI 注册表（`registry.ts`）

```ts
export interface AiCliRegistryEntry {
    id: string                    // 'claude-code' —— 即 D3 的 aiCli.kind
    name: string                  // 'Claude Code'（品牌名不进翻译）
    binaries: string[]            // 探测名列表，如 ['claude']（不含平台后缀，见 §4 解析）
    versionArgs: string[]
    versionPattern: RegExp
    launchArgs?: string[]
    icon: string                  // require('./icons/x.svg')
    tier: 'full' | 'launch'       // M1 行为一致，仅展示分级
    docsUrl?: string
}
```

首发：`claude-code` / `codex` / `gemini-cli` / `opencode` / `aider` / `pi`。各条目 binaries 在 Windows 实测确认。

## 4. 扫描器与设置页

```ts
export interface DetectedCli {
    entry: AiCliRegistryEntry
    command: string                       // 解析后的绝对路径
    launcher: 'exe' | 'cmd' | 'ps1' | 'sh'  // 由扩展名判定，决定启动包装（§5）
    version: string | null
}
```

- 探测（每条目）：`where`（win）/`which`（其余）逐 binary 命中即止 → 未中补查 npm 全局 prefix（`npm prefix -g` 一次缓存）、`~/.local/bin`、**config `aiCli.scanner.extraPaths`**；`aiCli.scanner.hidden` 中的条目跳过。
- **Windows shim 现实（审查 #5）**：npm 全局 CLI 在 win 下是 `.cmd`/`.ps1` shim，不可直接交给 node-pty spawn（仓库先例：tabby-local/src/cli.ts:107 对 .bat/.ps1 专门换 shell）。扫描器记录 `launcher` 类型，启动包装在 §5 统一定义。
- 版本探测：`<cmd> <versionArgs>` 2s 超时；**超时必须终止进程树**（win `taskkill /T /F`，unix kill 进程组），失败仅 `version=null`。
- 全条目并行、总超时 5s；结果 **`scanResults$: BehaviorSubject<DetectedCli[]>`**（订阅即得当前值，Dashboard/Provider 不用关心时序）；启动后惰性首扫 + 设置页/空状态"重新扫描"。
- **设置页**（`SettingsTabProvider` + `aiSettingsTab`）："重新扫描"按钮、extraPaths 编辑、按注册表条目的隐藏开关。
- 已知限制（记录不修）：上游 profiles 设置页只监听 `config.changed$`（profilesSettingsTab.component.ts:48），重扫不会即时刷新其列表；但选择器每次打开都现取 `getBuiltinProfiles()`，实际入口不受影响。

## 5. Profile 集成（`profiles.ts`）

- `AiCliProfileProvider extends ProfileProvider<AiCliProfile>`，`id = 'ai-cli'`。
- **configDefaults.options 必须全量声明**（审查 #6：ConfigProxy 只暴露 defaults 中声明的键，config.service.ts:58）——复制 LocalProfilesService 的完整键集（restoreFromPTYID/command/args/cwd/env(__nonStructural)/width/height/shellType/pauseAfterExit/runAsAdministrator）另加：

```ts
aiCli: { kind: null, version: null }   // 与 D3 结构一致（审查 #11），版本未知为 null
```

- `getBuiltinProfiles()`：`scanResults$.value` → `{ id: 'ai-cli:<kind>', type: 'ai-cli', icon, isBuiltin: true, options: buildLaunchOptions(cli) }`。
- **平台化启动包装 `buildLaunchOptions`（审查 #5）**：
  - `exe`/`sh`：`command = 绝对路径`，`args = launchArgs`；
  - win `cmd`：`command = 'cmd.exe'`，`args = ['/c', shimPath, ...launchArgs]`；
  - win `ps1`：`command = 'powershell.exe'`，`args = ['-ExecutionPolicy','Bypass','-File', shimPath, ...launchArgs]`；
  - 路径含空格依赖 args 数组逐项传递（node-pty 负责引用）；**验证点 V1**：三种 launcher 在含空格路径下实测（`C:\Program Files\...` 场景）。
- `getNewTabParameters(profile)`：`{ type: TerminalTabComponent, inputs: { profile } }`（tabby-local 公开导出），不自建 session；cwd 未指定时复制 LocalProfilesService 的"继承活动终端 cwd"逻辑。
- **补全抽象契约（审查 #6）**：`getDescription(p)` 返回启动命令行摘要；`getSuggestedName(p)` 返回 `<name> (<version>)`。
- **验证点 V2**：`ai-cli` 型 profile 经 tabby-local RecoveryProvider 重启恢复的完整性（token 内嵌 profile，预期可行；若 profile 恢复后丢 aiCli 元数据，M2 前必须修）。

## 6. 配置 schema（`config.ts`）

```yaml
aiCli:
  dashboard:
    openOnStart: true
    reopenWhenEmpty: true
  scanner:
    extraPaths: []
    hidden: []
hotkeys:
  toggle-dashboard: ['Ctrl-Shift-H']   # HotkeyProvider 契约要求（hotkeyProvider.ts:11，审查 #9）
```

**放弃 `terminal.autoOpen` 默认值覆盖**（审查 #3：defaults 按插件名序合并，config.service.ts:183 + plugins.ts:224，`tabby-local` > `tabby-ai` 后合并必胜，且用户已存值本就不受 defaults 影响）。启动协调完全走 §7 的 CLIHandler 短路。

## 7. Dashboard 与启动协调

**组件**：`DashboardTabComponent extends BaseTabComponent`；DOM/样式迁移 `docs/demo/dashboard-v3.html`，颜色读主题变量/ANSI 色位，等宽字体读终端字体配置。不重写 `getRecoveryToken`（保持 null，见 §1）。

**会话发现（审查 #1，P0）**：终端从不以裸 tab 存在——`ProfilesService/openNewTab` 会包进顶层 `SplitTabComponent`（app.service.ts:184-191），profile 在内部 pane 上。`dashboard.service` 的数据源：

```ts
rows = app.tabs.flatMap(top => {
    const panes = top instanceof SplitTabComponent ? top.getAllTabs() : [top]
    return panes
        .filter(p => p instanceof TerminalTabComponent && p.profile?.type === 'ai-cli')
        .map(pane => ({ topTab: top, pane }))
})
```

跳转 = `app.selectTab(topTab)`；若为 split 再 `topTab.focus(pane)`。板头计数按 rows 计。订阅 `app.tabsChanged$` + 各 tab 标题变更刷新。

**启动协调（审查 #2/#3/#4）**：
- `OpenDashboardCLIHandler`：`firstMatchOnly = true`，`priority = 0`（高于 AutoOpenTabCLIHandler 的 -1000，cli.ts:136-137）。匹配条件**仅** `!event.secondInstance && event.argv._.length === 0 && config.aiCli.dashboard.openOnStart`；命中则订阅 `app.ready$` 打开 Dashboard 并 `return true`——经 hostApp.service.ts:33 的 firstMatchOnly 链自然短路 AutoOpenTabCLIHandler，默认终端不再打开。其余一律 `return false`，不吞 `tabby <path>` 等既有命令行为。
- **Welcome（审查 #2）**：上游 `enableWelcomeTab: true` 会在 ready 后另开 Welcome（tabby-core/src/index.ts:168），与 handler 链无关，必须改默认值：`tabby-core/src/configDefaults.yaml` 一行 `enableWelcomeTab: false`（vibby 以 Dashboard 取代 Welcome；先例：enableAnalytics 已在该文件改过）。老用户配置中已存的 true 仍会开一次 Welcome——可接受，关掉即写回 false。
- 重开：订阅 `app.tabsChanged$`，`tabs.length === 0 && reopenWhenEmpty` → 重开。
- 单实例：`dashboard.service.open()` 先查现存实例（含 split 内），有则聚焦。
- 呼出：工具栏按钮（weight 负值居左）+ `toggle-dashboard` 热键——**模块构造函数订阅 `HotkeysService.hotkey$` 执行**（审查 #9，仅注册 Provider 不会有任何行为）。

**i18n（审查 #12）**：字符串上 `translate` 管道，英文为 key；**中文词条写入根 `locale/zh-CN.po`（正式上游触点）**；tab 标题/tooltip 随语言切换的刷新遵循上游同类组件行为（setTitle 一次性，重启后生效），不做额外热更新。状态词短词表 + `--stcol` 机制在 M1 仅"未监听"一档，先立机制。

## 8. NgModule 注册（`index.ts`）

```ts
providers: [
    { provide: ProfileProvider,       useClass: AiCliProfileProvider,    multi: true },
    { provide: ConfigProvider,        useClass: AiCliConfigProvider,     multi: true },
    { provide: ToolbarButtonProvider, useClass: ButtonProvider,          multi: true },
    { provide: HotkeyProvider,        useClass: AiHotkeyProvider,        multi: true },
    { provide: SettingsTabProvider,   useClass: AiSettingsTabProvider,   multi: true },
    { provide: CLIHandler,            useClass: OpenDashboardCLIHandler, multi: true },
]
// 模块构造函数：hotkeys.hotkey$ → 'toggle-dashboard' → dashboardService.toggle()
//              app.tabsChanged$ → reopenWhenEmpty 逻辑
```

依赖：`tabby-core`、`tabby-local`、`tabby-settings`（SettingsTabProvider）——均 peerDependencies。

## 9. 上游触点清单

| 文件 | 改动 |
|---|---|
| `scripts/vars.mjs` | `builtinPlugins` 加 `'tabby-ai'` |
| `scripts/prepackage-plugins.mjs` | 清单同步（实现时核对 :18） |
| 根 `package.json` / `yarn.lock` | workspace 纳新包 |
| `app/package.json` | peerDependencies 登记（照其他插件） |
| `tabby-core/src/configDefaults.yaml` | `enableWelcomeTab: false`（一行，审查 #2） |
| `locale/zh-CN.po`（及其余需要的语言） | tabby-ai 词条（审查 #12） |

appRoot/StartPage 仍零改动（§7 出场机制旁路）。~~tabby-local autoOpen 改动~~已由 CLIHandler 短路方案取代，删除。

## 10. 验收标准

1. 干净启动 → **只有** Dashboard（无默认终端、无 Welcome）；无 AI CLI 机器显示空状态 + "重新扫描"；
2. 装有 claude 的机器：站台条 chip（图标/版本正确）→ 点击开出运行 `claude` 的终端（**Windows .cmd shim 经 cmd.exe 包装正常进入交互**）；Dashboard 会话区出现"未监听"行（**会话在 split 包装内也能被发现**），计数正确，点击行跳转并聚焦正确 pane；
3. "配置与连接"选择器出现 AI CLI 内置 profile，可启动（变体编辑 = M1.5）；
4. 关闭全部标签 → Dashboard 自动重开；重启应用 → Dashboard 恰好一个（无恢复竞态双开）；
5. 工具栏按钮与 `Ctrl-Shift-H` 均可呼出/聚焦（热键含 config 默认值，改键生效）；
6. `tabby <某路径>` / 二次实例等既有 CLI 行为不受 handler 影响；
7. 设置页可重扫/补路径/隐藏条目，隐藏后 chip 与内置 profile 同步消失；
8. 中英 locale 切换无硬编码汉字；zh-CN.po 含全部新词条；
9. `yarn build` 全量通过；与 upstream/master 合并演练冲突面仅限 §9 清单。

## 10.5 实现完成记录（2026-07-24，WP0–WP5 已提交）

实测结论与偏差：

- **V1 通过**：node-pty 的 `argsToCommandLine` 会给含空格参数自动加引号，数组形式 `['/c', shimPath, ...]` 对空格路径、`(x86)` 括号路径、真实 npm `claude.cmd` 全部工作。（排障记录：早期三轮"失败"均为测试脚本反斜杠被转义损坏产生的换页符假警报，非引号问题。）
- **V2 静态通过**：恢复链路 `recoveryProvider → getConfigProxyForProfile → providerForProfile('ai-cli') → 我们的 configDefaults`，`aiCli` 元数据键已声明故可保全；动态回归见下方清单。
- 扫描器需 `await config.ready$`（模块构造早于配置加载，已修）。
- cliChip 未拆独立组件——两处场景同属 dashboard 模板，内联即可，少一层抽象。
- dev 模式下 electron argv 偏移使 `tabby profile <name>` 二次实例测试无效（会开新窗口），chip 启动链路依赖上游 `launchProfile`（与选择器同路径）。
- 本机验证环境仅装有 claude-code（原生 exe）与 opencode；`.cmd` shim 路线经 node-pty 直测验证。
- 界面已在浅色主题 + zh-CN/en 双语言下截图验证。

**待人工回归清单**（需要 UI 交互，交付前过一遍）：

- [ ] 点击 Claude Code chip → 打开运行中的 claude 会话，Dashboard 出现对应行，点行跳转
- [ ] 会话 split 后行数与聚焦正确
- [ ] 关闭全部标签 → Dashboard 自动重开；`Ctrl-Shift-H` 呼出
- [ ] 重启后恢复的 AI 会话保留 `aiCli` 元数据（V2 动态部分）
- [ ] 设置页：重扫/隐藏开关/额外路径三个交互
- [ ] `tabby <路径>` 与二次实例行为不受影响（打包版验证）

## 11. 实现顺序

1. 包骨架 + 构建接入（空模块加载成功）
2. registry + scanner（含 shim 判定与进程清理；console 验证）
3. ProfileProvider + 平台化启动包装（**V1 空格路径、V2 恢复链路两个验证点在此做**）
4. Dashboard 组件迁移 → 接 scanner / 会话发现（split 遍历）
5. 启动协调（CLIHandler 短路 + Welcome 默认值 + 重开 + 按钮/热键订阅）
6. 设置页 + i18n 清扫（locale/zh-CN.po）+ 验收清单全过
