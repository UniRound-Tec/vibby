# OpenCode 全监听：接口调研与集成建议

> 调研日期：2026-07-27
> 目标版本：本机 OpenCode `1.17.9`
> 范围：只确定官方能力、集成边界和验证闸门，不实施功能。

## 1. 结论

OpenCode 的首选监听源应是其 TUI 自带的本地 HTTP server 与 SSE 事件流，而不是
PTY 文本解析或持久安装全局插件。

推荐集成路径：

1. Vibby 在启动 OpenCode 时显式注入 `--hostname 127.0.0.1 --port <port>`。
2. 同时通过环境变量注入每 pane 随机生成的
   `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`。
3. OpenCode 适配器从 loopback-only `/event` 读取结构化事件并翻译成
   Vibby `AiEvent`；传输层支持 Basic Auth，但普通 TUI 1.17.9 不能启用它。
4. SSE 首连和每次重连后调用 `/session/status` 做状态补偿，避免断线期间状态丢失。
5. OpenCode 原生 session ID 只留在适配器内部；Dashboard、通知和硬件继续消费
   Vibby 的 pane 级 session ID。
6. 直接 AI profile 与普通终端内手动执行 `opencode` 都复用现有
   `TerminalCliShimService`，但不写用户的全局或项目级 OpenCode 配置。

这条路径使用 OpenCode 自己给 TUI/IDE/Web 客户端使用的协议，信号精度高，且不会
依赖 TUI 版本、主题或重绘方式。

## 2. 已确认的官方事实

### 2.1 TUI 本身就是 server 的客户端

OpenCode 官方 server 文档明确说明：运行普通 `opencode` 时会同时启动 TUI 和
server；TUI 是 server 的客户端。TUI 默认随机选择端口，也支持显式传入
`--hostname` 和 `--port`，以便其他客户端连接。

来源：

- [OpenCode Server：How it works](https://opencode.ai/docs/server/)
- [OpenCode CLI：TUI flags](https://opencode.ai/docs/cli/)
- [OpenCode 官方仓库](https://github.com/anomalyco/opencode)

这意味着 Vibby 不需要额外启动第二个 headless server，也不需要把 TUI 改成
`opencode attach` 架构；只需让原本内嵌的 server 使用一个 Vibby 已知的端点。

### 2.2 server 提供稳定的结构化读取面

官方 server 文档列出了：

- `GET /global/health`：健康状态和版本。
- `GET /event`：当前 project/directory 的 SSE 事件流。
- `GET /global/event`：跨 project 的全局 SSE 事件流。
- `GET /session/status`：所有 session 的当前状态。
- `GET /session`、`GET /session/:id`、`GET /session/:id/message`：会话与消息读取。
- `GET /doc`：由运行中版本发布的 OpenAPI 3.1 规范。

`/event` 的首条事件是 `server.connected`，之后转发内部 bus 事件。

来源：

- [OpenCode Server API](https://opencode.ai/docs/server/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [官方生成 SDK 类型](https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js)

### 2.3 本地 server 支持 Basic Auth，但 1.17.9 普通 TUI 不兼容

设置 `OPENCODE_SERVER_PASSWORD` 后，OpenCode server 使用 HTTP Basic Auth；
用户名默认是 `opencode`，也可由 `OPENCODE_SERVER_USERNAME` 覆盖。官方文档明确
说明该机制适用于 `serve` 和 `web`，而普通 TUI 复用同一 server 实现。

来源：

- [OpenCode Server：Authentication](https://opencode.ai/docs/server/#authentication)
- [OpenCode CLI：Environment variables](https://opencode.ai/docs/cli/#environment-variables)
- [server 实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/server.ts)

2026-07-27 的真实 TUI 闸门进一步确认：普通
`opencode --hostname 127.0.0.1 --port <port>` 可以正常提供 health、SSE 和
status；但一旦设置上述密码，TUI 内置客户端请求自己的
`/config/providers?directory=...` 时不携带 Authorization，收到 401 后退出。

因此当前实现必须只绑定 `127.0.0.1`，普通 TUI 不注入 server password。传输层保留
可选 Basic Auth，供 `serve/web` 或未来已修复的版本使用。这意味着同机其他进程理论
上可以访问已知端口，是当前 OpenCode TUI 协议的明确安全边界，不应伪称已鉴权。

### 2.4 事件粒度足够覆盖“四态 + 字幕”

本机 `@opencode-ai/sdk@1.17.9` 的官方生成类型已核验以下事件：

- `session.created` / `session.updated` / `session.deleted`
- `session.status`，状态为 `idle | busy | retry`
- `session.idle`
- `session.error`
- `message.updated`
- `message.part.updated`
- `permission.updated` / `permission.replied`

其中 `message.part.updated` 的 part 是判别联合，包含：

- `text`
- `reasoning`
- `tool`，并带 `pending | running | completed | error` 状态
- `step-start` / `step-finish`
- `subtask` / `agent`
- `retry` / `compaction`
- `file` / `patch` / `snapshot`

来源：

- [session 状态实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts)
- [消息与 part 类型](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts)
- [server 事件路由](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/event.ts)
- 本机随 OpenCode `1.17.9` 安装的官方
  `@opencode-ai/sdk/dist/gen/types.gen.d.ts`

当前开发版文档/类型已把权限事件命名演进为 `permission.asked`，并增加
`question.asked` / `question.replied` / `question.rejected`。因此实现必须做运行时
判别和别名兼容，不能只按最新文档静态假定事件名。

来源：

- [OpenCode Plugins：Events](https://opencode.ai/docs/plugins/#events)
- [question 路由](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/question.ts)
- [permission 路由](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/permission.ts)

### 2.5 Plugin 能监听，但不适合作为主集成面

OpenCode 插件可以订阅统一 `event` hook，也能截获 tool、permission、command 和
shell 生命周期。插件可从全局/项目插件目录或配置中的 npm 包加载。

来源：

- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [官方 plugin 类型](https://github.com/anomalyco/opencode/tree/dev/packages/plugin)

但把 Vibby 插件持久写进 `~/.config/opencode` 或项目 `.opencode` 会带来：

- 修改用户配置和仓库工作树；
- 插件版本与 OpenCode 版本耦合；
- 启动安装、Bun 依赖和第三方插件冲突；
- 清理失败后残留；
- hook 失败可能影响实际 agent 操作。

所以 plugin 只适合作为未来兼容旧版本或特殊发行版的备选通道，不应作为第一版
“全监听”的默认路径。

### 2.6 ACP 不是监听现有 TUI 的协议

`opencode acp` 是一个单独的 Agent Client Protocol server，适合由 IDE/宿主直接
驱动 agent。它会改变 Vibby 与 OpenCode 的所有权边界：Vibby 将从“终端宿主 +
观察者”变成“agent client”。

来源：

- [OpenCode ACP Support](https://opencode.ai/docs/acp/)
- [OpenCode CLI：ACP](https://opencode.ai/docs/cli/#acp)

本项目仍要保留原生 TUI，因此 ACP 不作为当前监听通道。

## 3. Vibby 现状与缺口

可直接复用：

- `AiEvent` / `AiSessionSnapshot` 四态协议。
- `AiEventBusService`、feed、attention pulse。
- `TerminalCliShimService` 的 direct/manual 双路径注入。
- `RuntimeCliDetectorService` 的进程识别。
- Dashboard、侧栏和桌面通知的消费逻辑。

必须先抽象：

- `AiTabStateService`、`AiAttentionService` 和 Dashboard 目前直接依赖
  `ClaudeAdapterService` 查询 pane ↔ Vibby session。
- `ClaudeAdapterService` 同时承担 pane 发现、注入、传输、事件翻译、状态字幕和
  清理；若直接加入 OpenCode 分支会变成多 CLI 条件树。
- `HookIngressService` 在入口处直接调用 `translateClaudeHook`，不是通用 ingress。

需要一个通用的 session binding/monitor registry，统一提供：

- `sessionIdForPane(pane, kind?)`
- `paneForSessionId(sessionId)`
- adapter 生命周期注册和清理

CLI 特有的 hook、SSE、端口、凭据、重连、原生 session 聚合全部藏在具体
adapter 内。

## 4. 建议的 OpenCode → AiEvent 映射

| OpenCode 信号 | Vibby 事件 | 状态 |
|---|---|---|
| SSE 连接成功 / `server.connected` | `session-started` | `idle`（随后以 status 补偿） |
| user `message.updated` | `prompt-submitted` | `working` |
| reasoning `message.part.delta`（实时）/ `message.part.updated`（收尾） | `thinking`，逐段累积并取最新一段；普通 busy 保持 working，避免无 reasoning 时误报 | `working` |
| `session.status: busy` | `prompt-submitted` 或内部 reconcile | `working` |
| tool part `pending/running` | `tool-call` | `working` |
| `permission.updated` / `permission.asked` | `permission-request` | `needs-you` |
| `question.asked` | `permission-request`（v0） | `needs-you` |
| `session.status: retry` | `notification` 或新增 `retrying` 事件 | 保持 `working` |
| `session.idle` / status `idle` | `turn-completed` | `idle` |
| `session.error` / assistant message error | `process-exited` 前新增 error 语义更佳 | `error` |
| OpenCode 进程退出 | `process-exited` | `error`，正常退出可定格 idle |

### Tool summary

优先取 `ToolPart.state.title`，其次按 `tool + state.input` 生成：

- read/write/edit：文件 basename
- bash：command 截断
- grep/glob：pattern
- task/subtask：description
- 其他：小写 tool 名

### 多原生 session

一个 OpenCode TUI pane 可能切换 session，也可能产生 child/subagent session。
Vibby 对外仍保留一个 pane 级 session。适配器内部维护：

```text
native session id -> { parent id, last status, pending permission/question, last activity }
```

聚合优先级建议：

```text
needs-you > busy/retry > error > idle
```

主 session 已 idle 但 child 仍 busy 时，pane 仍显示 working；任一相关 session 有
permission/question 时显示 needs-you。

## 5. 连接和恢复策略

1. 通过真实 loopback bind 分配可用端口，避开 Windows excluded port ranges。
2. 在 PTY spawn 前注入 CLI 参数和环境。
3. PTY 启动后轮询 `/global/health`，总预算建议 5–8 秒。
4. 校验返回版本，再打开带 Authorization header 的 Node HTTP SSE 请求。
5. SSE 断开时指数退避重连；pane 销毁或进程退出时取消。
6. 每次连接成功后读取 `/session/status`，覆盖本地推断状态。
7. 支持 pending permission/question 列表的版本，重连后再读列表；旧版只能以后续
   SSE/status 为准。
8. 未知事件只记录 debug，不影响连接；未知 payload 不得让整个 stream 退出。

不能直接使用浏览器原生 `EventSource`：传输层仍需支持可选 Basic Auth header、
超时与主动取消。应使用 Node `http.request` + 小型 SSE parser。

## 6. “全监听”验收边界

必须覆盖：

- Dashboard/AI profile 直接启动 OpenCode。
- 普通本地终端内手动执行 `opencode`。
- 两个并发 pane 与 split pane 不串线。
- prompt → busy → tool → permission/question → busy → idle。
- retry、provider error、进程异常退出。
- TUI session 切换与 child/subagent 活动聚合。
- SSE 短断线、server 慢启动、重连后的状态补偿。
- tab 关闭、恢复、复制后无 stale port/shim/可选 auth secret。
- 用户 OpenCode plugins/config 原样保留，不写全局和项目配置。
- 不支持或协议不匹配时降级为“已识别、未监听”，不伪报状态。

不在第一版范围：

- 从 Dashboard 直接批准 permission 或回答 question。
- 驱动 OpenCode TUI 的 `/tui/*` 控制 API。
- 监控 Vibby 外部启动且端口/凭据未知的 OpenCode 进程。
- 通过 ACP 取代原生 TUI。

## 7. 实施前验证闸门

### V1：参数与认证（已执行）

Windows/OpenCode 1.17.9 已验证固定 hostname/port、`/global/health`、
`/event` 首包与 `/session/status`。Basic Auth 闸门未通过：会使普通 TUI 自身
401 退出，因此实现采用 loopback-only 无认证连接。macOS/Linux 仍待平台矩阵验证。

### V2：真实 SSE 事件表

用 OpenCode `1.17.9` 记录一次完整回合：prompt、reasoning、tool、permission、
question、retry、idle、error，冻结实际 payload fixture。不能只依赖开发版类型。

### V3：manual shim

验证普通 shell 中的 `opencode`、`opencode run`、`opencode --version`、
`opencode attach`、`opencode serve` 在 shim 下的行为；对不启动内嵌 server 的
子命令必须快速降级，不得卡住。

### V4：端口竞态与恢复

验证并发启动 10 个 pane、应用崩溃后恢复、端口占用、server 启动失败和 SSE
重连。任何失败都不能影响 OpenCode 本身的 TUI 可用性。

### V5：版本矩阵

至少覆盖当前基线 `1.17.9` 和一个事件命名已切换到
`permission.asked/question.asked` 的版本。由 `/global/health` 记录版本，翻译器用
payload 判别而非单一版本分支。

## 8. 设计决策建议

- 选 server/SSE，不选 PTY scrape。
- 选 pane 级统一 binding，不把 OpenCode native session 暴露给 UI。
- 选运行时 payload guards，不直接把最新 SDK 类型当稳定 ABI。
- 选临时 CLI/env 注入，不写用户配置。
- 选 reconnect + status reconciliation，不把 SSE 当绝不丢包的日志。
- 第一版只读监听；permission/question 的响应能力另开里程碑。
