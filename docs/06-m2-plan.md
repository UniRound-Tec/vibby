# M2 实施计划（能看能提醒）

> 依据：`03-ai-terminal-design.md` D2/D5/D7。M2 没有独立 spec，本文件兼任契约定义（§1–§4）与施工顺序（§5–§8）；实现偏差回写本文件。
> 编写：2026-07-24

## 0. 范围一句话

统一事件模型 + Claude Code 适配器（拉起时自动注入 hooks，用户零配置）+ Dashboard 会话行实况（四态状态字 + 通栏字幕 + hover 事件 feed）+ attention 桌面通知。**只做 Claude Code 一个适配器**（D2"少而真"），其余 CLI 维持 M1 的"未监听"展示不动。

不在范围：thinking 摘要的 transcript 解析（§9 增强项）、硬件下发（M3）、对外 WebSocket（悬置）。

## 1. 事件模型 v0（契约，`tabby-ai/src/events.ts` 单独成文件）

从第一天按对外协议的严谨度写——M3 硬件、将来开放协议都直接消费它。

```ts
export type AiSessionState = 'working' | 'needs-you' | 'idle' | 'error'

export type AiEventKind =
    'session-started' | 'prompt-submitted' | 'tool-call' |
    'permission-request' | 'turn-completed' | 'notification' |
    'session-ended' | 'process-exited'

export interface AiEvent {
    sessionId: string            // vibby 侧会话 id（uuid，spawn 时生成）
    ts: number
    kind: AiEventKind
    confidence: 'high' | 'low'   // hook=high；控制序列/启发式=low（本期全为 high）
    summary: string              // 小屏就绪短文本，≤48 字符，生产端截断（D5）
    raw?: unknown                // 原始 hook payload，UI 不依赖
}

export interface AiSessionSnapshot {
    sessionId: string
    state: AiSessionState
    since: number                // 进入当前状态的时刻（Dashboard 时长列）
    lastEvent: AiEvent | null
}
```

- **两层分离**（D5）：状态机是事件流的 reducer，卡片用色只看 state，字幕/feed 只看事件。
- summary 动词前缀保持英文不译（`edit: auth.ts` / `bash: npm test`），§2.5 定稿。

### 状态机迁移规则（Claude Code hooks → 状态）

| hook 事件 | AiEvent.kind | 状态迁移 |
|---|---|---|
| `SessionStart` | session-started | → idle |
| `UserPromptSubmit` | prompt-submitted | → working |
| `PreToolUse` | tool-call | → working（保持），刷新字幕 |
| `Notification` | permission-request / notification | → needs-you |
| `Stop` | turn-completed | → idle |
| `SessionEnd` | session-ended | 会话结束（行保留，状态定格 idle） |
| PTY 进程退出（非 0 / 无 SessionEnd 先导） | process-exited | → error |

- `Notification` 一并覆盖权限审批、AskUserQuestion、60s 空闲等待——正好对应 D5"needs-you 顶层不细分"，细分语义放 payload。
- `PostToolUse`/`SubagentStart/Stop`/`PreCompact` v0 不订阅（降噪）；字幕新鲜度靠 PreToolUse 足够。
- **attention 脉冲**（D5，软硬件共用信号）：状态机 `working → 任意其他状态` 的跳变即触发点，M2 消费者 = 桌面通知，M3 消费者 = 灯闪。

### summary 提取规则（PreToolUse.tool_input）

| tool_name | summary |
|---|---|
| Edit / Write / Read | `edit:`/`write:`/`read:` + 文件名（仅 basename） |
| Bash | `bash: ` + command 截断 |
| Grep / Glob | `grep: ` + pattern |
| Task | `agent: ` + description |
| 其他 | 小写 tool 名原样 |

## 2. 收线机制（hook 进程 → vibby 渲染层）

- **回环 HTTP**：tabby 渲染层有 node 集成，`HookIngressService` 用 `http.createServer` 监听 `127.0.0.1:随机端口`，路径带随机 token 防同机进程伪造（`POST /vibby/<token>/event/<sessionId>`）。每窗口一个 server——Tabby 多窗口时各窗口只承载自己 spawn 的会话，天然对齐，无需跨窗口路由。
- **hook 命令用 curl**：Win10 1803+ / macOS / Linux 均内置。`curl -s -m 3 --data-binary @- -H "Content-Type: application/json" <url>`，stdin 的 hook JSON 原样转发。`-m 3` 硬超时保证 hook 不拖慢 claude（hooks 是阻塞执行的，收线端必须"秒回 200 再慢慢消化"）。
- **不依赖 shell 变量展开**：Windows(cmd) 与 unix(sh) 展开语法不同，URL（含端口/token/sessionId）在 spawn 时直接**烧进生成的 settings JSON 里**为字面量，跨平台零分支。

## 3. hooks 注入（Claude Code 适配器的核心）

- spawn 时生成一次性 settings 文件（userData 下 `hook-inject/<sessionId>.json`），内容 = 上表 6 个事件各挂一条 curl 命令；启动参数追加 `--settings <该文件>`。
- **合并语义是安全网**：hooks 在多来源 settings 间是**叠加合并**而非覆盖——用户自己的 hooks 照常执行，我们的只是多一份订阅（WP2 闸门实测确认）。
- 只对 `aiCli.kind === 'claude-code'` 注入；registry 该条目 tier=full 即适配器挂载开关（D3）。
- 会话相关性：URL 里的 sessionId 是 vibby 的；payload 里 claude 自己的 `session_id` 与 `transcript_path` 存进事件 raw，供 §9 增强项与将来 debug 用。
- 清理：SessionEnd/进程退出后删除注入文件；启动时清扫孤儿文件。

### 恢复链路的注入卫生（M1 V2 的续篇）

`--settings` 追加**不能落进 profile.options / 恢复 token**——否则重启恢复会带着 stale 端口/token 复活。规则：注入发生在"从 options 构造实际 SessionOptions"的最后一步（provider 的 launch 路径），构造前先剥离任何遗留的 `--settings <userData>/hook-inject/*` 参数再追加新的（幂等）。WP2 闸门 V5 专测。

## 4. UI / 通知消费端

- **Dashboard 实况化**（demo V3 已画好的部分接真数据）：状态字上色（黄=等你/蓝=运行/绿=空闲/红=异常，ANSI 色位映射已在 M1 就绪）；排序硬规则 needs-you > working > idle > error > 未监听；字幕列 = lastEvent.summary + 相对时间；板头计数器分态统计；needs-you 行动效（全板唯一动效，§2.5）；hover 浮出最近事件 feed（每会话环形缓冲 30 条）。
- **桌面通知**：working→needs-you 跳变时发系统通知（标题=会话名，正文=summary），**仅当窗口未聚焦或该会话 tab 不在前台**时发（避免自我打扰）；点击通知聚焦对应 pane（复用 M1 focusRow 链路）。working→error 同样通知。idle 跳变不通知（只进 Dashboard）。
- 配置项：`aiCli.events: { notifications: true, notifyOnIdle: false }`，设置页加开关。

## 5. 工作包

依赖：WP0 → WP1 → WP2 → WP3 → WP4 → WP5。WP0 纯类型+纯函数可先行；WP3 静态部分可与 WP2 并行。

### WP0 事件模型 + 会话总线
- `events.ts`（§1 契约）+ `AiEventBusService`：`events$`（全局流）、`snapshots$`（Map<sessionId, snapshot>）、每会话环形缓冲、状态机 reducer 为纯函数。
- 完成判据：reducer 的迁移表用单测覆盖（含 working→needs-you 的 attention 标记）；构建通过，无 UI 变化。
- Commit：`feat(ai): event model v0 and session event bus`。

### WP1 收线服务 ⚠️ 闸门 V3
- `HookIngressService`：server 生命周期（窗口启动开、退出关）、token 校验、payload→AiEvent 翻译入口、立即 200 响应。
- **V3**：终端手工 `curl --data-binary @sample.json <url>` → devtools 里 events$ 出事件；错 token 得 404；server 关闭后 curl 快速失败不挂起。
- Commit：`feat(ai): hook ingress over loopback http`。

### WP2 Claude Code 适配器（注入 + 翻译）⚠️ 闸门 V4/V5
- settings 文件生成、参数幂等剥离/追加、6 事件的 payload→AiEvent 映射、summary 提取规则、清理逻辑。
- **V4（真实会话全链路）**：Dashboard 开 claude → 提交 prompt 状态转 working；触发一次权限审批转 needs-you；放行后回 working 且字幕随 PreToolUse 滚动；回合结束转 idle；`exit` 后行定格。**用户已有 `~/.claude/settings.json` hooks 时两边都执行**（合并语义实证）。
- **V5（注入卫生）**：重启恢复的会话无 stale `--settings` 残留、恢复后新注入生效；连开两个 claude 会话事件不串线。
- 不过则停：若 `--settings` 合并行为与预期不符（覆盖用户 hooks / 需交互确认），备选方案见 §7 风险表，改完再继续。
- Commit：`feat(ai): claude code hooks adapter`。

#### 闸门记录（2026-07-24 实施后回写）

- **注入缝定稿**：`app.tabOpened$` 同步发射（addTabRaw 内），PTY spawn 迟至 `onFrontendReady`——tabOpened 订阅者改 `tab.profile.options` 必然赶在 spawn 前；新开/恢复/复制三条路径统一覆盖，`--settings` 不进 profile 存储。恢复 token 确实会带走注入后的 args（getRecoveryToken 存 tab.profile），幂等剥离因此是必需项。
- **V4 通过**（真实 claude v2.1.218 全链路）：session-started→ready；prompt-submitted→working；PreToolUse 字幕滚动（`bash: git status`、`edit: <file>`）；permission-request（"Claude needs your permission"）与 60s 空闲 notification 双双验证 needs-you；Stop→idle；`/exit`→SessionEnd（reason=prompt_input_exit）状态定格。`--settings` 与用户 settings 为叠加合并，注入文件只含 hooks 键、不碰用户配置。
- **V5 通过（含一次真实失败与修复）**：恢复的 split 子 pane **不发 `tabAdded$`**（recoverContainer 直调 attachTabView，绕过 onAfterTabAdded）——首测 stale `--settings` 复活。修复：visit split 时等 `initialized$` 后全量 sweep + `tabsChanged$` 兜底 sweep（armed WeakSet 保幂等）。复测：两个 claude 进程命令行各恰好 1 个 `--settings`，全指向当前 pid 的新文件；双会话 sessionId 独立不串线。恢复 profile 是 ConfigProxy，实证可写。
- **error 路径降级为尽力而为（已知限制）**：Windows ConPTY 下外部硬杀 claude 时，若其子进程（MCP server 等）仍挂在 console 上，pty 不报 exit → `destroyed$` 不发射 → error 状态无法翻转（上游 Tabby 对普通 shell 行为相同）。干净退出（SessionEnd 先行）与 tab 关闭清理均正确。§8-4 验收按此限制解读：kill 后行保持最后已知状态，不误报。macOS/Linux 无此问题（SIGKILL 即关 pty）。

### WP3 Dashboard 实况化
- 会话行接 snapshots$（状态字/排序/时长）、字幕列接 lastEvent、hover feed 浮层、计数器分态、needs-you 动效。行数据源从"扫 tabs"改为"扫 tabs ⋈ snapshots"（无 snapshot 的 ai-cli 行 = 未监听态，未监听 CLI 的既有展示不变）。
- 完成判据：与 demo V3 满载态逐项对照（状态色、排序、动效唯一性）；两会话并发时字幕各自滚动；会话关闭行消失、计数即时更新。
- Commit：`feat(ai): live dashboard board`。

### WP4 attention 通知
- 跳变检测订阅 + 系统通知（聚焦判定、点击聚焦 pane）+ 配置开关 + 设置页两行。
- 完成判据：窗口失焦时权限请求弹通知、点击回到正确 pane；窗口聚焦且该 tab 在前台时不弹；开关关掉后全静默。
- Commit：`feat(ai): attention notifications`。

### WP5 收尾
- locale 词条（状态词表 zh：等你/运行/空闲/异常/未监听 已在 M1 就位，补新增设置项/通知文案）；§8 验收全量回归记录；docs 回写；`git fetch upstream` 合并演练（连同 M1 的 task #10 一起关账——上次演练 vacuous）。
- Commit：`feat(ai): M2 polish and locale` / `docs: M2 implementation notes`。

## 6. 上游触点

**预期新增：仅 `locale/zh-CN.po`**。全部功能收在 tabby-ai 包内，无新 core/local 改动——这是本里程碑合并纪律的验收项之一。

**实际（含 M2 收尾修复）**：
| 文件 | 改动 | 合并风险 |
|---|---|---|
| `locale/zh-CN.po` | 新增词条 | 无（纯追加） |
| `tabby-core/src/components/tabHeader.component.ts` | `miniHeader` HostBinding + `displayIndex` getter | 低（新增成员） |
| `tabby-core/src/components/tabHeader.component.pug` | `{{index + 1}}` → `{{displayIndex}}`（2 处） | 低（单点替换） |
| `tabby-core/src/components/appRoot.component.ts` | `tab-N` 热键跳过 mini tab | 低（3 行） |
| `tabby-core/src/components/tabHeader.component.pug` | 3 行 vibby 挂载点（`.ai-icon`/`.ai-state`/`.ai-summary`，全部 `*ngIf` 兜底） | 低（纯追加） |
| `tabby-core/src/components/tabHeader.component.ts` | `data-ai-group` HostBinding | 低（新增成员） |
| `tabby-core/src/configDefaults.yaml` | `tabsLocation: top` → `left` | 低（单值） |
| `tabby-local/src/index.ts` | 不注册 `ButtonProvider`（「+」新终端按钮） | 低（删 1 行 + 2 处 import，`buttonProvider.ts` 原样保留） |
| `tabby-core/src/services/profiles.service.ts` | 选择器里内置 profile 自带 `group` 时保留自己的分组，并翻译「内置」 | 低（1 行） |
| `tabby-core/src/icons/plus.svg` | Font Awesome → Tabler（描边） | 低（整文件替换） |
| `tabby-settings/src/icons/cog.svg` | Font Awesome → Tabler（描边） | 低（整文件替换） |
| `tabby-core/src/commands.ts` | 「配置和连接」所有平台都用 `plus.svg`（上游仅 Web 用） | 低（3 行 + 删一个未用的注入） |
| `tabby-settings/src/components/settingsTab.component.ts` | `miniHeader = true` | 低（新增成员） |

编号那三项是 Dashboard 作为 mini tab 不该占用序号的必然代价：编号既在头部渲染又在 `tab-N` 热键里，两处都在 core。

主页和设置都是 `miniHeader` tab：tab 列表里完全不渲染，入口只有工具栏按钮。这带来一条横向布局的修正——上游把工具栏排在 tab 列表**之后**，去掉 mini tab 后主页会从最左跑到中间，所以注入样式表里给横向布局的首个按钮组加 `order: -1`（选择器用 `.tabs + .btn-group` 而非 `:first-of-type`——of-type 数的是 div，`.tabs` 也是 div，永远选不中）。侧栏布局不受影响，工具栏本来就固定在底部。

侧栏其余外观（卡片布局、分组标题、底部工具栏、状态色）**全部走 tabby-ai 注入的样式表**，core 不含任何 vibby 专属样式——挂载点只提供 DOM 和数据，样式留在插件侧，这是刻意的合并纪律。

侧栏收缩（`aiCli.rail.collapsed`）同样零 core 触点：`RailService` 只往 `<body>` 挂 `vibby-rail-collapsed` 类，收缩态的全部布局在同一张注入样式表里。其中 `body.vibby-rail-collapsed .window { min-height: 0 }` 是必需的——工具栏在窄栏里改为竖排后，flex item 默认的 `min-height: auto` 会把整个窗口布局顶出视口底部 30px（标题栏高度）。

工具栏四个图标统一为 **Tabler Icons（MIT，描边 2px）**：主页和折叠在 `tabby-ai/src/icons/`，「+」和设置只能替换 core / settings 里的原文件（上游把图标路径写死在各自的 provider 里，没有替换点）。候选方案见 `docs/mockups/toolbar-icons.html`，由 `scripts/fetch-icons.mjs` + `scripts/build-icon-mockup.mjs` 生成，换图标不必手抄 SVG。

描边图标有一个坑：主题（`theme.new.scss`）和 `appRoot.component.scss` 都给 `.btn-tab-bar svg` 强制 `fill`，会把描边图标灌成实心色块。注入样式表里用 `svg[stroke] { fill: none !important }` 兜住——按属性选择而不是按类，这样 core 那两个文件也覆盖到，且换成别的描边图标集时不用改。

## 7. 风险表

| 风险 | 位置 | 预案 |
|---|---|---|
| `--settings` 合并语义不符（覆盖用户 hooks / 弹确认） | WP2 | 备选注入通道按序试：`CLAUDE_CODE_*` 环境变量类开关 → 项目级 `.claude/settings.local.json` 写入（侵入用户目录，需明示）→ 降级为设置页一键生成 hooks 配置（放弃零配置，如实标注） |
| claude 旧版本无 hooks / 事件集不同 | WP2 | registry 为 full tier 加 minVersion；探测版本低于门槛→按"未监听"降级展示，不注入 |
| hook 阻塞拖慢 claude | WP1/2 | curl `-m 3` + 收线端先 200 后处理；V4 观察回合延迟无感 |
| Windows cmd 对 hook command 的引号解析 | WP2 | URL 无空格无特殊字符（token 用 hex），command 不含需转义内容；仍出问题则 hook 命令改为写临时 bat |
| 多窗口/多会话事件串线 | WP1 | sessionId 在 URL 路径里，token 每窗口独立；V5 双会话实测 |
| 恢复链路 stale 注入 | WP2 | §3 幂等剥离规则 + V5 专测（M1 V2 同款闸门思路） |
| 通知打扰（needs-you 抖动） | WP4 | 同会话通知 5s 节流；notifyOnIdle 默认关 |

## 8. 验收标准

1. 干净启动 → Dashboard 开 claude：状态流转 idle→working→(needs-you→)idle 全程正确，字幕随工具调用滚动。
2. 权限审批场景：窗口失焦弹桌面通知，点击聚焦到正确 pane；聚焦时不弹。
3. 两个并发 claude 会话（其一 split pane）：事件不串线，排序遵守 needs-you > working > idle。
4. claude 进程被外部 kill：行转 error（红），通知一次。
5. 用户自有 hooks 与注入 hooks 共存，两边都执行。
6. 重启恢复：会话重新拉起后监听自动重建，无 stale 注入参数。
7. 未监听 CLI（如 opencode）行为与 M1 完全一致，标注"未监听"。
8. 通知开关关闭后全静默；语言切换 en/zh 无残留。
9. 上游触点核对（§6 表）；合并演练通过。

## 9. 增强项（不阻塞 M2 交付，做完验收后视余力）

- **think 字幕 = 抓官方 spinner 短语**（2026-07-24 用户定稿，替代原 transcript JSONL 解析方案）：Claude Code 工作中自带 `✻ <短语>… (Ns · ↓ N tokens)` 的官方状态展示，vibby 是 PTY 宿主，该内容本就流经我们——正是 D2 的"控制序列/PTY 输出"层。抓取通道按序：① 终端标题 OSC（claude 默认更新终端标题，`CLAUDE_CODE_DISABLE_TERMINAL_TITLE` 反证；Tabby 的 `tab.title$` 现成）；② 去 ANSI 后正则匹配输出尾部的 spinner 行，仅取短语。置信度标 low，只填 working 期间字幕（`think: <短语>`），**状态机仍只信 hooks**。
- ~~本地使用统计~~（2026-07-24 用户裁决：暂不需要）。

## 10. 完成定义

§8 九条全绿 + 三个闸门（V3/V4/V5）通过记录在案 + 上游触点核对 + 本文件偏差回写。

## 11. 实施记录（2026-07-24，WP3–WP5）

- **WP3**：看板行 = tabs 枚举 ⋈ snapshots（join 键 = adapter 的 pane→sessionId WeakMap）；四态字上色 + 排序 + 时长列（5s tick）+ hover feed + 分态计数已上线，截图验证 2 空闲 + 4 未监听混排正确。needs-you 底色渐变用 `color-mix`（Chromium 111+，Electron 满足）。
- **WP4**：`AiAttentionService` 订阅 attention$；已实测最小化窗口时 working→needs-you 发射通知（日志佐证）；聚焦门控/点击聚焦为代码审查级验证，列入 §12 手动清单。toast 可见性受系统通知设置（勿扰/Electron 应用权限）影响。
- **WP5**：zh-CN.po 新增 10 词条（状态词 等你/运行/空闲/异常 + 通知设置组）；合并演练仍为空转（上游 master 无新提交），M2 上游触点仅 `locale/zh-CN.po` 一个文件，达成 §6 目标；全量 `yarn build` 通过（78.7s）。
- 测试残留已清理：dev config 测试 profile、tmp 注入文件、测试进程；未触碰用户真实 `~/.claude` 配置。
- **收尾修复（2026-07-25）**：
  - **think 字幕落地，通道改判**（§9）：通道②（去 ANSI 后正则匹配 PTY 输出）**实证不可行**——用 node-pty 直连 claude 抓原始流可见其状态行是**差分重绘**（只重写变化的字符格，中间穿插光标跳转），`✻ Spelunking… (4s · ↓ 2 tokens)` 到达时序为 `g✶Spelunkn✻✽i…kg✻nn✶ui*✢lk·enpu✢Sl*e✶(4s · ↓2 tokens)`，语序不可恢复。改用**通道③：读渲染后的 xterm 屏幕缓冲区**（`frontend.xterm.buffer.active`，自 `baseY` 起自底向上扫可见行），600ms 轮询、仅 working 会话、跑在 Angular zone 外、仅文本变化时 `zone.run`。短语正则必须 Unicode 感知（`\p{Lu}\p{L}+`）——claude 词表含 `Flambéing`/`Nöödling` 等重音字母，ASCII 类必然漏匹配。
  - **子会话环境标记**：vibby 若由 claude 会话拉起，子进程继承 `CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION` 等标记会误判嵌套（"Transcript saving is off"）。arm 时以空串覆盖（`mergeEnv` 里后写胜出，空串读作未设），`ANTHROPIC_*` 不动——那是用户配置。
  - **mini tab 不占序号**：Dashboard 是 mini tab，`{{index + 1}}` 让真实 tab 从 2 起编。改为 `displayIndex`（非 mini tab 中的序位），`tab-N` 热键同步过滤，上游触点见 §6。
- **发现的产品问题（留 M2.5/M3 议）**：① cwd 落在未信任目录时 claude 卡在 trust 确认页，Dashboard 无从体现——考虑 profile 默认 cwd 策略或状态识别；② PTY 已死但事件未收尾的 tab 恒显"未监听"，与真未监听 CLI 无法区分；③ claude 的 OSC 标题（`✳ <短语>`）已实证流经 `tab.title$`，§9 think 字幕通道①成立。

## 12. 手动回归清单（需真人 UI 交互）

1. Dashboard 开 claude → 打字提问：行转"运行"（蓝）、字幕随工具滚动、回合结束转"空闲"（绿）。
2. 触发权限审批：行转"等你"（黄+呼吸动效）且置顶；窗口失焦时收到桌面通知，点击通知回到正确 pane；窗口聚焦且停留在该 tab 时不弹。
3. hover 会话行：浮出最近事件 feed（时间 + 摘要）。
4. split 两个 claude 面板：两行独立状态互不干扰，点击行聚焦到正确 pane。
5. 设置页"通知"两开关：关"该你了提醒"后全静默；开"回合结束时也通知"后 idle 有静默通知。
6. 语言切 en：状态词/设置项无汉字残留；切回 zh 全部命中（等你/运行/空闲/异常）。
7. `claude` 里 `/exit`：行定格"空闲"、tab 自关；重启应用后恢复的会话自动重建监听（状态从 ready 重新开始）。
