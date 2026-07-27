# OpenCode 全监听实施计划

> 制定日期：2026-07-27
> 上游调研：`07-opencode-monitoring-research.md`
> 状态：第一版已实施并通过单测、lint、类型与全量构建；真实事件回合和跨平台矩阵待验收。

> 2026-07-27 闸门修正：OpenCode 1.17.9 普通 TUI 的内置客户端不会携带
> Basic Auth，设置 server password 会令 TUI 自身 401 退出。当前实现仅绑定
> `127.0.0.1` 且不为普通 TUI启用 auth；传输层保留可选 auth 支持。

## 0. 目标

让 Vibby 对 OpenCode 达到与 Claude Code 同级的结构化监听能力：

- 直接从 Dashboard/profile 启动与普通终端内手动启动都能监听；
- 正确显示 working、needs-you、idle、error；
- 展示 prompt、tool、permission、question、retry、error 等实况摘要；
- 多 pane、split pane、OpenCode child/subagent session 不串线；
- SSE 断线可重连并用 REST 快照补偿；
- 不修改用户的全局或项目 OpenCode 配置；
- 协议不可用时明确降级，不伪造状态。

第一版只读监听，不从 Vibby 直接批准权限或回答问题。

## 1. 接口方案比较

### 方案 A：极简会话目录 + 单流 adapter

消费者只拿一个 pane/session 双向目录；每个 CLI adapter 返回
`bound/event/live-status/unbound` 流。它的优点是消费面极小，未来新增 CLI 不改 UI。

问题在于 Observable 同时承担“PTY spawn 前同步注入”和“spawn 后异步事件”时，订阅
时机很容易成为隐式约束；普通终端中连续 invocation 的 bound/unbound 协议也会把
复杂度推给协调层。

可保留它的最佳部分：UI 只依赖一个通用会话目录。

### 方案 B：事件驱动生命周期插件

插件显式参与 claim、prepare、attach、reconcile、dispose，并可暴露控制命令。
它最适合未来有大量异构 CLI、需要权限回复/问题回答/中断等控制能力的场景。

问题是当前只有 Claude 和 OpenCode 两个 full-tier adapter，这套协议一次暴露了启动
修改、secret、transport health、native subject、reconcile 和 commands，接口过宽，
容易形成浅层框架；实现者也更容易错误管理 pane mutation 和清理。

它的两个关键结论应纳入最终方案：

- OpenCode 并行子会话需要 adapter 提供显式聚合态，不能只靠“最后一个事件获胜”。
- 连接健康与 agent 业务状态必须分开；SSE 断线不等于 OpenCode session error。

### 方案 C：SessionBinding + MonitorHandle

一个 pane 绑定一个长期 `MonitorHandle`，handle 暴露 phase、snapshot 和 dispose。
它最贴合当前 pane-centric UI，直接/手动启动都只需一次 `bind()`。

问题是 handle 暴露 snapshot 后会与 `AiEventBusService` 形成第二个状态源；固定枚举
Claude/OpenCode 也会让第三个 full-tier CLI 必须修改协调器。长期 handle 的思想正确，
但公开状态应继续由现有 event bus 单独拥有。

### 综合选择

采用：

1. **通用 `AiSessionDirectory`**：唯一公开身份查询面，替代 UI/通知对
   `ClaudeAdapterService` 的依赖。
2. **`AiCliMonitorAdapter.arm()` 深接口**：同步完成 pre-spawn 准备，内部自行订阅
   PTY/session 生命周期、连接事件源、重连和清理。
3. **`AiMonitorHandle` 只持身份和 dispose**：不复制 snapshot；所有业务状态继续只进
   `AiEventBusService`。
4. **multi-provider 注册 adapter**：协调器不写 Claude/OpenCode switch。
5. **pane 级稳定 Vibby session ID**：OpenCode 原生 root/child session 只在 adapter
   内部聚合，不暴露给 UI。

这个形状最小，同时把真正复杂的部分藏得足够深。

## 2. 定稿接口

建议新建 `tabby-ai/src/monitoring.ts`：

```ts
import { InjectionToken } from '@angular/core'
import { TerminalTabComponent } from 'tabby-local'

import { DetectedCli } from './api'

export interface AiSessionBinding {
    /** Vibby pane-level session ID; also used by AiEvent.sessionId */
    readonly sessionId: string
    readonly kind: string
    readonly pane: TerminalTabComponent
}

export interface AiSessionDirectory {
    forPane (
        pane: TerminalTabComponent,
        kind?: string | null,
    ): AiSessionBinding | null

    forSession (sessionId: string): AiSessionBinding | null
}

export interface AiMonitorContext {
    readonly pane: TerminalTabComponent
    readonly launch: 'direct' | 'manual'
    readonly detected: DetectedCli | null
}

export interface AiMonitorHandle {
    readonly binding: AiSessionBinding

    /**
     * Idempotent. Pane destruction also disposes automatically.
     * Implementations abort transports and remove temporary resources.
     */
    dispose (): void
}

export interface AiCliMonitorAdapter {
    readonly kind: string

    /**
     * Called before PTY spawn.
     *
     * Must synchronously apply every launch-time mutation needed for
     * monitoring. It may start asynchronous transport work internally after
     * sessionChanged$ reports a live PTY.
     *
     * Returns null when the pane cannot be monitored safely.
     */
    arm (context: AiMonitorContext): AiMonitorHandle | null
}

export const AI_CLI_MONITOR_ADAPTERS =
    new InjectionToken<readonly AiCliMonitorAdapter[]>(
        'AI_CLI_MONITOR_ADAPTERS',
    )
```

`AiMonitorCoordinatorService` 实现 `AiSessionDirectory`，独占：

- tab/split/recovery 遍历；
- adapter 选择与重复 arm 防护；
- pane ↔ session 双向索引；
- `AiEventBusService.dropSession()`；
- tab/PTY 销毁竞态；
- Angular zone 切换。

具体 adapter 独占：

- 启动参数、环境和 shim；
- vendor transport；
- vendor payload decoder；
- 重连与状态补偿；
- 原生 session 聚合；
- 临时资源清理。

### 重要不变量

- UI、Dashboard、通知不得导入任何具体 adapter。
- adapter 不得把 OpenCode SDK 类型泄漏到 `events.ts` 或 UI。
- `AiEventBusService` 是 snapshot 的唯一事实源。
- 一个 pane 只有一个 active binding。
- `arm()` 到达太晚时必须返回 null/降级，不能修改已经运行的 PTY options。
- adapter 的网络断线不得直接发布业务 `error`。

## 3. 事件协议调整

现有事件类型够表达基本四态，但不足以保留 OpenCode 的完整语义。扩展
`AiEventKind`：

```ts
export type AiEventKind =
    'session-started' |
    'prompt-submitted' |
    'tool-call' |
    'tool-result' |
    'permission-request' |
    'question-request' |
    'request-resolved' |
    'retrying' |
    'turn-completed' |
    'notification' |
    'session-error' |
    'session-ended' |
    'process-exited'
```

给 `AiEvent` 增加可选投影：

```ts
export interface AiEvent {
    // existing fields...

    /**
     * Adapter-projected aggregate state.
     * Needed when multiple native sessions share one Vibby pane.
     */
    projectedState?: AiSessionState
}
```

reducer 规则：

```ts
const nextState =
    event.projectedState ??
    stateAfter(event.kind) ??
    previousState ??
    'idle'
```

Claude 不需要设置 `projectedState`，行为保持不变。OpenCode 每次事件后根据整棵相关
session 树计算：

```text
needs-you > error > working > idle
```

这样 child A idle 不会覆盖 child B busy，权限请求也始终压过普通 busy。

## 4. OpenCode adapter 内部设计

建议文件：

```text
tabby-ai/src/opencodeEvents.ts
tabby-ai/src/services/openCodeAdapter.service.ts
tabby-ai/src/services/openCodeSse.service.ts
tabby-ai/test/opencodeEvents.test.cjs
tabby-ai/test/fixtures/opencode-1.17.9/*.json
```

### 4.1 启动准备

每个 pane 生成：

- loopback 端口；
- loopback-only 端点；`serve/web` 或未来兼容版本可选 Basic Auth；
- stable Vibby session ID。

注入：

```text
--hostname 127.0.0.1 --port <port>
OPENCODE_SERVER_USERNAME=<random>
OPENCODE_SERVER_PASSWORD=<random>
```

直接 profile 修改临时 launch options；普通 shell 使用 per-pane PATH shim。不得写：

- `~/.config/opencode`
- 项目 `opencode.json/jsonc`
- 项目 `.opencode/plugins`

若启用凭据，不得进入 event.raw、日志、profile 恢复 token 或错误文本；普通 TUI
当前不注入凭据。

### 4.2 连接

1. PTY live 后连接 `GET /event` 并读取 `GET /session/status`；按模式可选 Basic Auth。
2. 总启动预算 8 秒，带小幅退避。
3. health 成功后打开 `GET /event?directory=<cwd>` SSE。
4. 不能使用浏览器原生 `EventSource`；用 Node HTTP/fetch stream，以便设置
   Authorization header 和 AbortSignal。
5. SSE parser 只负责 framing；JSON decoder 单独做运行时 guards。

### 4.3 首连与重连补偿

正确顺序：

1. 先打开 SSE 并暂存事件；
2. 并行读取 session 列表、`/session/status`，以及当前版本存在的 pending
   permission/question 列表；
3. 重建 native session parent/child 图；
4. 投影权威 aggregate state；
5. 去重后回放暂存 SSE；
6. 再拉一次短暂状态，封住快照窗口；
7. 进入 live。

SSE 无历史重放保证，不能只依赖 `Last-Event-ID`。断线后指数退避 + jitter，每次成功
重连都重复补偿。

### 4.4 版本兼容

decoder 同时接受：

- `permission.updated`（本机 1.17.9 生成类型）
- `permission.asked`（当前官方文档/开发版）
- `permission.replied`
- 有则接收 `question.asked/replied/rejected`

未知事件忽略并 debug 计数；未知 payload 不关闭整条 stream。`/global/health` 的版本
仅用于诊断和兼容测试，不用一大段硬编码版本分支代替 runtime guards。

### 4.5 session 归属与聚合

内部记录：

```ts
interface NativeSessionState {
    id: string
    parentId: string | null
    status: 'busy' | 'retry' | 'idle' | 'error'
    pendingPermissionCount: number
    pendingQuestionCount: number
    lastActivityAt: number
}
```

相关 root/child/subagent session 映射到同一 Vibby session ID。历史 idle session 不得
参与当前 pane 聚合。需要用创建时间、parentID、当前 TUI选择/活动事件和工作目录共同
确定 active roots；该算法必须用真实 fixtures 和双 session 手工闸门验证。

### 4.6 事件摘要

- tool running：优先 `state.title`，其次 tool + input。
- read/write/edit：basename。
- bash：command 截断。
- grep/glob：pattern。
- subtask/agent：description/name。
- permission/question：官方 title/question 截断。
- retry：message + attempt。
- error：安全的错误摘要，不包含 headers、body、key 或完整 prompt。

所有 summary 最终仍走 `clampSummary()`。

## 5. 工作包

### WP0：真实协议冻结（实施闸门）

先在真实 OpenCode `1.17.9` 会话中验证：

- TUI 接受固定 hostname/port；
- 验证 Basic Auth 与 TUI兼容性；1.17.9 已确认不兼容并采用 loopback-only 降级；
- `/event` 与 `/session/status` 可用；
- 捕获 prompt、tool、permission、question、retry、idle、error 的真实 payload；
- 明确普通 TUI、`run`、`attach`、`serve` 子命令的参数行为。

产物只允许是脱敏 fixtures 和闸门记录。V1/V2 不通过，不进入 WP2。

### WP1：通用 monitor seam，无行为变化

- 新增定稿接口和 `AiMonitorCoordinatorService`。
- 把现有 Claude 服务包装/拆分为 `AiCliMonitorAdapter`。
- Dashboard、`AiTabStateService`、`AiAttentionService` 改依赖
  `AiSessionDirectory`。
- 保持 Claude hooks、spinner、通知和恢复行为完全不变。
- registry `tier` 暂保留，但启动时断言 full entry 必须有 adapter；后续再考虑由
  provider 推导，避免本次扩大迁移面。

验收：

- 现有纯函数测试全绿；
- Claude 真实回归全绿；
- UI/通知无具体 adapter import。

### WP2：OpenCode 纯 decoder + 聚合器

- 定义最窄 vendor DTO 和 runtime guards。
- 翻译两套 permission 命名。
- tool/permission/question/retry/error summary。
- native session graph 与 projected aggregate state。
- event dedupe。

验收：

- 全部用 WP0 fixtures 做纯单测；
- 乱序 child 创建、并行 busy、child idle、permission 压制、session 删除、重复事件、
  未知事件全部覆盖；
- 不启动 Electron、不连真实网络即可跑完。

### WP3：OpenCode transport

- Basic-auth REST 客户端。
- SSE framing、AbortSignal、heartbeat/停滞检测。
- health 等待、退避重连。
- 首连/重连 snapshot reconciliation。
- 401、404、schema mismatch、server exit 的分类处理。

验收：

- 用本地 fake server 测分片 SSE、多个 data 行、注释/heartbeat、半包、坏 JSON、
  断线、401、重连和补偿窗口；
- secret 永不进入日志；
- transport 断线不误报 session error。

### WP4：启动注入与 manual shim

- direct profile 临时 args/env。
- OpenCode 专用 conditional shim。
- 普通 `opencode` 和 `opencode run` 接入。
- 对 `attach`、用户自带 `--port`、`serve/web/acp` 明确 passthrough 或降级规则。
- stale args/env/shim 清理与恢复卫生。

验收：

- 命令转发矩阵在 Windows cmd、POSIX sh 覆盖；
- 用户参数和 cwd 不变；
- 两个 pane 端口/密码/session ID 独立；
- 同一个普通 shell 退出 OpenCode 后再次启动仍可监听；
- 非监听子命令不被破坏。

### WP5：UI/通知全链路

- OpenCode registry `tier` 改为 `full`。
- Dashboard、侧栏、hover feed 显示结构化摘要。
- question 与 permission 都显示 needs-you。
- retry 保持 working 并更新字幕。
- session error 显示 error；transport reconnect 仍显示最后可信业务态或 listening。
- 通知点击回到正确 pane。

验收：

- direct/manual/split/并发/子会话/断线场景真人回归；
- zh/en 文案；
- 通知节流与聚焦门控。

### WP6：收尾

- 全量 `yarn test`、`yarn build`、lint。
- 更新 `docs/03-ai-terminal-design.md` 中“只有 Claude full”的旧决策。
- 把真实验证结果和已知限制回写本计划。
- 检查所有临时 shim、端口、凭据和测试配置均已清理。

## 6. 验收标准

1. Dashboard 启动 OpenCode，首次连接显示 listening，随后按真实状态进入 idle。
2. 提交 prompt：working；tool 摘要连续更新；完成后 idle。
3. permission 与 question：needs-you、置顶、通知；回答后恢复 working/idle。
4. provider retry：仍为 working，字幕显示 retry 信息，不误报 error。
5. session.error 或异常 PTY 退出：error；单纯 SSE 断线不进入 error。
6. 普通终端手动执行 `opencode` 获得同等监听；退出后再执行仍生效。
7. 两个 tab + split pane 四路并发不串线。
8. child/subagent busy 时 root idle 不会把 pane 判为空闲；任一 child needs-you 即整体
   needs-you。
9. 模拟 SSE 断线后自动重连，断线期间发生的终态由 REST 补偿回来。
10. 用户 OpenCode config/plugins 无任何写入；用户参数、provider、model 和 cwd 不变。
11. 重启恢复、复制 pane、关闭 tab 后无 stale port/shim/可选 auth secret。
12. 不兼容版本或 server 启动失败时明确显示未监听/降级，OpenCode TUI 本身仍可用。

## 7. 主要风险

### 端口交接竞态

操作系统没有为任意子进程提供通用 socket activation。先取空闲端口、再让 OpenCode
绑定存在极小竞态。WP0 必须验证 OpenCode 对 `--port 0` 是否有可发现端点；若没有，
首版采用随机高位端口 + bind 前检查 + 冲突分类，并把“冲突不得破坏 TUI”设为闸门。

### manual 子命令兼容

静态前置参数可能破坏 `attach/session/models` 等不启动本地 server 的命令。不能把
现有通用 shim 原样套用；必须有 OpenCode 专用参数路由并测试命令矩阵。

### API 快速演进

`1.17.9` 与当前开发文档已经出现 permission/question 命名差异。vendor decoder 要
窄、运行时判别、fixture 驱动；不要把整个 `@opencode-ai/sdk` 类型树导入核心协议。

### 原生 session 归属

server 可以看到多个历史或 child session。若 active-root 算法不严谨，会把旧会话的
事件算进当前 pane。WP2/WP5 必须以 session 切换和子代理并发作为硬闸门。

### “全监听”不能变成“全控制”

server API 能批准 permission、回答 question、驱动 TUI，但第一版只读。控制能力会
引入权限、安全和误操作问题，另立设计与授权流程。

## 8. 完成定义

WP0–WP6 全部完成，12 条验收标准全绿，真实 OpenCode payload fixtures 已脱敏入库，
Claude 回归无退化，且本文件记录实际版本、已知限制和验证结果。
