# AI Session 悬浮窗实施计划

> 制定日期：2026-07-27
> 状态：已实现并完成 Windows dev 验证
> 样式原型：[`mockups/floating-window-prototype.html`](mockups/floating-window-prototype.html)

## 0. 目标

增加一个独立、轻量、始终可见的 AI Session 悬浮窗，让用户不切回 Vibby 也能：

- 看到当前所有已打开 AI Session 的状态；
- 看到每个 Session 最近一次有意义的事件；
- 默认只看最近活动的 3 个 Session；
- 展开后访问全部 Session；
- 点击任一 Session，快速恢复并聚焦其所属 Vibby 窗口、顶层 Tab 和 Split Pane；
- 在黑色深色主题和白色浅色主题间，跟随主程序自动切换。

悬浮窗是只读状态面板，不启动新的 AI 扫描、监听或终端会话。

## 1. 已定产品规则

### 1.1 内容和排序

- 默认最多显示 3 个 Session；
- Session 总数大于 3 时，底部显示小尺寸“展开另外 N 个会话”；
- 展开后渲染全部 Session；当高度超过当前屏幕工作区时，列表内部滚动；
- 收起后立即回到最新活动的 3 个 Session；
- 排序按 `lastActivityAt` 倒序；
- 相同活动时间按 `createdAt` 倒序，再按 `sessionId` 做稳定兜底；
- 点击聚焦、窗口获得焦点、轮询和 live-status 刷新不改变活动排序；
- Session 新事件到达后允许卡片自动移动到首位。

`lastActivityAt` 使用结构化 `AiEvent` 的 `ts`。`setLiveStatus()` 只更新文案，不更新时间，
避免 spinner、心跳或低置信度输出令列表持续跳动。

### 1.2 每条 Session 的首版信息

- CLI 图标；
- Session 名称；
- 当前状态；
- 最近事件摘要；
- 距离最近活动的相对时间。

首版不在悬浮窗里展开完整事件历史；完整历史仍留在 Dashboard。

### 1.3 窗口外观

- 无标题栏；
- 不显示 “AI Sessions”、Session 数量等顶部标签；
- 不显示置顶钉子；
- 不显示缩小或关闭按钮；
- 只保留 Session 内容与小尺寸展开/收起控件；
- 窗口外缘保留不可见拖拽区域，Session 行和展开按钮明确设为 `no-drag`；
- 悬浮窗开关放在主程序的 AI CLI 设置页；
- 关闭开关时销毁或隐藏悬浮窗，不依赖悬浮窗自身的窗口控件。

### 1.4 黑白两套颜色

首版只维护两套明确 token，不让悬浮窗直接继承任意终端配色：

```ts
export type FloatingWindowColorScheme = 'dark' | 'light'
```

建议初始 token：

| Token | 黑色主题 | 白色主题 |
| --- | --- | --- |
| window | `transparent` | `transparent` |
| panel | `#19181c` | `#ffffff` |
| surface | `#242228` | `#f5f4f3` |
| surfaceHover | `#2d2a31` | `#eceae8` |
| text | `#f6f3f1` | `#191719` |
| muted | `#aaa3ad` | `#6e6870` |
| border | `rgba(255,255,255,.10)` | `rgba(0,0,0,.10)` |
| shadow | `rgba(0,0,0,.50)` | `rgba(40,32,36,.18)` |

状态色在两套主题中分别校准，不直接复用同一个十六进制值：

- working：深色底使用偏亮蓝紫，白色底使用更深蓝；
- needs-you：深色底使用亮琥珀，白色底使用深橙；
- idle：深色底使用亮绿，白色底使用深绿；
- error：深色底使用亮红，白色底使用深红。

文字和状态色最低满足 WCAG AA 普通文本对比度 4.5:1。

默认跟随主程序：

- `appearance.colorSchemeMode === 'dark'` → 黑色主题；
- `appearance.colorSchemeMode === 'light'` → 白色主题；
- `appearance.colorSchemeMode === 'auto'` → 跟随 `PlatformService.getTheme()`；
- 系统主题或主程序配置变化时，已打开的悬浮窗原地切换，不重新创建。

首版不增加悬浮窗独立主题选择器，避免出现主程序和悬浮窗配色不同步的第三种状态。

## 2. 首版边界

### 包含

- Windows、macOS、Linux 的 Electron 窗口基础实现；
- 多个 Vibby 普通窗口的 Session 聚合；
- Claude Code、OpenCode 及未来进入通用事件总线的 AI CLI；
- `working / needs-you / idle / error / listening / untracked` 展示态；
- 默认 3 条、展开全部、最新活动排序；
- 点击聚焦精确窗口、Tab、Split Pane；
- AI CLI 设置页内的启用开关；
- 黑/白双主题和自动切换；
- 窗口位置持久化。

### 不包含

- 在悬浮窗内批准权限、回答问题或输入 Prompt；
- 完整事件时间线；
- 置顶、缩小、关闭等可见窗口按钮；
- 悬浮窗独立主题选择器；
- 改变 Session 名称或关闭 Session；
- 拖动 Session 排序；
- 屏幕边缘自动吸附；
- 远程 Web 控制面板。

## 3. 架构选择

### 3.1 不复用完整 Angular/插件窗口

普通窗口的 `app/src/entry.ts` 会：

- 搜索和加载全部插件；
- bootstrap 完整 Angular 应用；
- 激活 AI scanner、ingress、adapter、runtime detector 和 tab recovery。

悬浮窗若直接加载同一入口，会无意义地启动第二套插件生命周期，甚至产生重复监听。
因此悬浮窗使用单独的轻量 renderer entry，只消费主进程推送的序列化快照。

### 3.2 数据流

```text
每个普通 Vibby renderer
  AiEventBusService + AiSessionDirectoryService + AppService
            │
            │ replace-window-snapshot(windowId, sessions, colorScheme)
            ▼
Electron 主进程 FloatingSessionHub
  - 按 windowId 聚合
  - 移除已关闭窗口的数据
  - 管理唯一悬浮窗
            │
            │ aggregate-snapshot
            ▼
轻量 floating renderer
  - 排序
  - 默认 slice(0, 3)
  - 展开/收起
  - 黑/白 token
            │
            │ focus-session(windowId, sessionId)
            ▼
主进程恢复目标窗口并通知目标 renderer
            │
            ▼
AiSessionNavigatorService 精确选择 Tab / Pane
```

主进程不理解 Claude/OpenCode vendor payload，也不持有 Angular 组件；它只保存可序列化
投影并负责窗口路由。

### 3.3 全量替换而非增量事件

每个普通窗口发布自己当前的完整 Session 列表：

```ts
interface FloatingWindowSessionSnapshot {
    sessionId: string
    sourceWindowId: number
    kind: string
    name: string
    state: AiDisplayState
    stateLabel: string
    summary: string | null
    createdAt: number
    lastActivityAt: number
}
```

采用 `replaceWindowSessions(windowId, sessions)`，不采用 `add/update/remove` 三套增量 IPC：

- 一次消息就是该窗口的权威状态；
- renderer reload 后可以直接覆盖旧状态；
- Session 销毁和 Split Pane 变化不需要补偿事件；
- 主进程在 `webContents.destroyed` 时按 `windowId` 删除整组数据；
- 更容易避免乱序 IPC 留下幽灵卡片。

发布使用 `auditTime(50~100ms)` 合并事件突发，但首个快照和 Session 删除必须及时送达。

## 4. 模块和接口设计

### 4.1 纯数据模型

新增 `tabby-ai/src/floatingSessions.ts`，只放：

- `FloatingWindowSessionSnapshot`；
- 排序函数；
- 默认三条投影函数；
- 主题枚举；
- IPC payload 的运行时边界校验/归一化；
- 相对时间显示所需的纯函数（若不直接放 renderer）。

该文件不导入 Angular 或 Electron，沿用 `events.ts`、`presentation.ts` 的可单测模式。

图标不通过 IPC 传递。轻量 renderer 在构建时打包内置 registry 的 `kind → SVG` 白名单，
未知 kind 使用通用终端图标，避免把任意 SVG/HTML 字符串送入悬浮页面。

### 4.2 Session 发布器

新增 `tabby-ai/src/services/floatingSessionPublisher.service.ts`：

- 注入 `AppService`、`ConfigService`、`PlatformService`、`BOOTSTRAP_DATA`；
- 订阅 `AiEventBusService.snapshots$`；
- 订阅 Session 绑定变化、tab/split 变化和标题变化；
- 将 pane 投影为序列化 snapshot；
- 以 `BOOTSTRAP_DATA.windowID` 标记来源窗口；
- 将完整列表通过 Electron IPC 发布给主进程；
- 配置关闭时发布空列表并通知主进程关闭悬浮窗；
- `beforeunload` 前发布窗口移除信号，主进程销毁监听作为最终兜底。

`createdAt` 在 publisher 首次见到 `sessionId` 时记录；如果首个结构化事件早于该时间，
使用首个事件时间。`lastActivityAt` 使用 `snapshot.lastEvent?.ts ?? createdAt`。

### 4.3 Session 导航器

新增 `tabby-ai/src/services/sessionNavigator.service.ts`，抽出当前通知点击中的定位逻辑：

```ts
class AiSessionNavigatorService {
    focus (sessionId: string): boolean
}
```

步骤：

1. `AiSessionDirectoryService.forSession(sessionId)` 查找 pane；
2. 在 `AppService.tabs` 中查找 pane 所属顶层 Tab；
3. `AppService.selectTab(topTab)`；
4. 若为 `SplitTabComponent`，调用 `topTab.focus(pane)`；
5. 返回是否找到。

`AiAttentionService` 和悬浮窗 IPC listener 共用该服务，避免两套聚焦逻辑漂移。

### 4.4 主进程 Hub

新增 `app/lib/floatingSessions.ts`：

```ts
class FloatingSessionHub {
    replaceWindowSessions (
        sender: WebContents,
        payload: FloatingWindowSourceSnapshot,
    ): void

    removeWindow (windowId: number): void
    setEnabled (enabled: boolean): void
    setColorScheme (scheme: 'dark' | 'light'): void
    focusSession (windowId: number, sessionId: string): void
    destroy (): void
}
```

职责：

- 校验 `event.sender.id` 与声明窗口是否匹配；
- 聚合所有普通窗口的 Session；
- 保证全应用最多只有一个悬浮窗；
- enabled 时创建/显示，disabled 时销毁；
- 将聚合快照广播给悬浮 renderer；
- 普通窗口关闭时清除对应快照；
- 应用退出时同步销毁；
- 不把悬浮窗加入普通 `Application.windows`，避免它成为 main window、参与托盘逻辑、
  全局热键显示/隐藏或接收 CLI 参数。

`Application` 增加只读的普通窗口查找方法，`Window` 增加封装好的
`restoreAndPresent()`；Hub 不直接访问 `Window` 的私有 `BrowserWindow`。

### 4.5 轻量窗口与 renderer

新增：

```text
app/lib/floatingSessionsWindow.ts
app/src/floatingSessions.entry.ts
app/src/floatingSessions.preload.ts
app/src/floatingSessions.scss
app/floating-sessions.pug
```

并在 `app/webpack.config.mjs` 增加独立 HTML 和 JS entry。

窗口建议参数：

```ts
{
    width: 352,
    height: collapsedContentHeight,
    minWidth: 300,
    maxWidth: 440,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: floatingPreloadPath,
    },
}
```

轻量 preload 只暴露：

- `subscribeSessions(callback)`；
- `subscribeColorScheme(callback)`；
- `focusSession(windowId, sessionId)`；
- `setExpanded(expanded, preferredHeight)`；
- 可选 `reportReady()`。

不向页面暴露任意 `ipcRenderer`。

### 4.6 尺寸与位置

- 收起高度由三条 Session 的实际行高加小按钮高度计算；
- 展开高度不超过当前 display `workAreaSize.height * 0.7`；
- 超出高度后只让内容列表滚动；
- 展开/收起时使用 `setContentSize()`，保持窗口顶部和右侧锚点不跳动；
- 使用独立的 `ElectronConfig({ name: 'floating-sessions-window' })` 保存位置；
- 不复用普通窗口的 `ElectronConfig({ name: 'window' })`；
- 恢复位置时校验仍与至少一个 display 相交，否则移动到主屏幕右上安全边距；
- display 增删或分辨率变化后重新夹紧 bounds。

## 5. IPC 契约

建议统一前缀 `ai-floating:`：

| 方向 | Channel | Payload |
| --- | --- | --- |
| 普通 renderer → main | `ai-floating:replace-source` | `{ windowId, sessions, enabled, colorScheme }` |
| 普通 renderer → main | `ai-floating:remove-source` | `{ windowId }` |
| main → floating | `ai-floating:snapshot` | `{ sessions }` |
| main → floating | `ai-floating:color-scheme` | `{ colorScheme }` |
| floating → main | `ai-floating:focus-session` | `{ windowId, sessionId }` |
| main → 普通 renderer | `ai-floating:focus-session` | `{ sessionId }` |
| floating → main | `ai-floating:set-expanded` | `{ expanded, preferredHeight }` |

安全约束：

- 主进程不接受 floating renderer 提供的任意 Electron window id；
- `windowId` 必须存在于 Application 的普通窗口集合；
- `sessionId` 必须当前属于目标窗口聚合快照；
- summary、name、kind 和 state 都在主进程入口限制类型和长度；
- 不跨 IPC 发送 `raw` vendor payload、终端输出、Prompt 全文、cwd 或环境变量。

## 6. 点击聚焦流程

1. 用户点击 Session 行；
2. floating renderer 发送 `{ sourceWindowId, sessionId }`；
3. Hub 验证该 Session 仍属于目标窗口；
4. 目标 `BrowserWindow` 若最小化则 `restore()`；
5. 若隐藏则 `show()`；
6. 调用 `moveTop()` 和 `focus()`；
7. 主进程向目标 renderer 发送 `{ sessionId }`；
8. `AiSessionNavigatorService` 选中顶层 Tab；
9. Split Tab 场景继续聚焦准确 pane；
10. 如果 Session 在步骤 1–8 间已关闭，目标 renderer 返回/记录 miss，主进程请求各窗口
    立即刷新快照，不选中相邻 Session。

点击本身不修改 `lastActivityAt`。

## 7. 主程序设置

在 `AiConfigProvider.defaults.aiCli` 增加：

```ts
floatingWindow: {
    enabled: false,
}
```

AI CLI 设置页增加：

```text
AI Session 悬浮窗                 [开关]
显示最近活动的 AI Session，点击可返回对应终端
```

规则：

- 首版默认关闭，避免升级后突然出现新置顶窗口；
- 打开后立即创建窗口并推送当前 Session；
- 关闭后立即销毁窗口；
- 配置在多个普通窗口间沿用现有 config broadcast 同步；
- 悬浮窗中不再放第二个开关；
- 暂不增加独立热键，后续根据使用反馈决定。

## 8. 样式落地

正式样式从选定的原型方向重写，不直接复制 throwaway HTML。

共同约束：

- 默认宽度约 352px；
- 单条 Session 保持 48–58px 高；
- 展开控件使用当前已缩小的轻量文字按钮；
- Session 行 hover 才出现表面层，不使用常驻重卡片边框；
- 需要用户处理的状态可突出，但不通过改变排序优先级覆盖“最新活动排序”；
- 相对时间每 30 秒或 60 秒批量刷新一次，不为每条 Session 创建独立 interval；
- 黑/白主题只切换 CSS variables，不生成两份 DOM；
- `prefers-reduced-motion` 下关闭重排动画；
- 自动重排动画只做短距离淡入/位移，不能妨碍点击目标；
- 展开时保持最新活动排序，不按状态分组。

无标题栏后的拖动策略：

- panel 外缘 6–8px 透明/空白区为 `-webkit-app-region: drag`；
- Session 行、展开按钮和滚动条为 `-webkit-app-region: no-drag`；
- 不增加可见拖动手柄或标签。

## 9. 生命周期与异常处理

### 没有 Session

- enabled 仍保留，但悬浮窗隐藏；
- 第一个 Session 出现时自动显示；
- 最后一个 Session 关闭时自动隐藏；
- 不显示大面积空状态窗口。

### 普通窗口 reload

- `webContents` 销毁时移除旧 source；
- reload 完成后的首个完整快照重新加入；
- 中间不保留幽灵 Session。

### 主窗口关闭但其他窗口仍存在

- 悬浮窗不绑定 “main window” 身份；
- 其他普通窗口的 source 继续存在；
- 只删除已关闭窗口所属 Session。

### 悬浮 renderer 崩溃

- Hub 清理引用；
- enabled 且仍有 Session 时允许一次受控重建；
- 连续崩溃不得无限重启，记录错误并保持主程序可用。

### 系统锁屏、全屏应用和多桌面

- 首版沿用普通 `alwaysOnTop`，不使用 macOS `screen-saver` 级别；
- 不主动跨所有虚拟桌面；
- 不覆盖系统锁屏、安全桌面或独占全屏；
- 若平台行为不同，在验收矩阵中记录，不用高权限层级强行抹平。

## 10. 实施顺序

### 阶段 1：纯模型和测试

1. 新增 snapshot 类型、排序和 collapsed projection；
2. 定义活动时间规则和稳定 tie-break；
3. 增加黑/白主题枚举和 IPC payload 校验；
4. 补纯函数单测。

### 阶段 2：主进程 Hub 和轻量窗口

1. 增加独立 webpack HTML/renderer/preload entry；
2. 实现 FloatingSessionHub；
3. 实现窗口创建、销毁、bounds 和独立位置持久化；
4. 实现无标题栏和动态尺寸；
5. 先用假 snapshot 验证黑白两套视觉。

### 阶段 3：真实 Session 发布

1. 为 Session directory 增加安全的 binding 变化读取面；
2. 实现 `FloatingSessionPublisherService`；
3. 接入 event bus、标题、split 和销毁变化；
4. 验证多普通窗口聚合和 source 清理；
5. 确认 floating renderer 没有启动 scanner/adapter。

### 阶段 4：点击聚焦

1. 抽出 `AiSessionNavigatorService`；
2. 让通知点击复用导航器；
3. 接通 floating → main → target renderer；
4. 验证最小化、隐藏、非激活窗口和 split pane；
5. 处理点击与 Session 关闭竞态。

### 阶段 5：设置和主题同步

1. AI CLI 设置页增加启用开关；
2. 接通 config broadcast；
3. 接通 dark/light/auto；
4. 校准黑白主题状态色和对比度；
5. 增加翻译条目。

### 阶段 6：验收和收尾

1. 全量单测、lint、类型和 build；
2. Windows 主矩阵手测；
3. macOS/Linux 基础窗口行为手测；
4. 清理原型依赖，正式组件不引用 prototype；
5. 把实施结果和偏差回写本计划。

## 11. 测试计划

### 11.1 纯函数单测

- 0、1、3、4、20 个 Session 的 collapsed/expanded 投影；
- `lastActivityAt` 倒序；
- 相同时间的稳定排序；
- live-status 不改变排序时间；
- 新事件令 Session 移到首位；
- 点击不改变排序；
- summary/name 长度和非法 state 的边界校验；
- dark/light scheme 归一化。

### 11.2 服务级测试

- 同一窗口全量 snapshot 替换；
- 两个窗口聚合；
- source reload 覆盖旧数据；
- source 销毁移除整组；
- 相同 `sessionId` 异常冲突时 fail closed；
- enabled/disabled 幂等；
- 无 Session 时隐藏、首个 Session 时显示；
- 主题变更不重建窗口；
- expanded 切换只改变尺寸和显示量。

### 11.3 手工验收矩阵

| 场景 | 预期 |
| --- | --- |
| 1–3 个 Session | 无展开按钮或不占额外大空间 |
| 4+ 个 Session | 默认 3 条，展开后可访问全部 |
| 新事件 | 对应 Session 移到首位 |
| live status 高频变化 | 文案更新但不重排 |
| 点击普通 Tab Session | 恢复窗口并选中 Tab |
| 点击 Split Pane Session | 选中顶层 Tab 并聚焦准确 Pane |
| 目标窗口最小化 | restore、置前、聚焦 |
| 目标窗口隐藏 | show、置前、聚焦 |
| 目标 Session 同时关闭 | 不跳到错误 Session，列表及时移除 |
| 多个 Vibby 窗口 | Session 聚合且点击回正确窗口 |
| 黑色主题 | 黑底、浅字、状态色对比合格 |
| 白色主题 | 白底、深字、状态色对比合格 |
| auto 模式切系统主题 | 原地切换，不闪出第二个窗口 |
| 关闭设置开关 | 悬浮窗消失且不再占用 renderer |
| 重启 Vibby | 开关和窗口位置恢复 |
| 拔掉外接显示器 | 悬浮窗回到可见工作区 |

## 12. 完成标准

- 悬浮窗没有标题、置顶、缩小或关闭控件；
- 开关只存在于主程序；
- 默认最多显示最新活动的 3 个 Session；
- 展开/收起控件保持小尺寸；
- 所有 Session 严格按最近结构化活动排序；
- 点击能精确恢复目标窗口、Tab 和 Split Pane；
- 多 Vibby 窗口不会串 Session；
- Session/window 销毁后没有幽灵卡片；
- 黑/白两套颜色在 dark/light/auto 下正确切换；
- 悬浮窗 renderer 不加载完整 Angular 插件栈，不启动第二套 AI 监听；
- 普通窗口边界和悬浮窗口边界使用不同持久化配置；
- 单测、lint、类型检查、全量构建通过；
- 计划中的实现偏差已回写本文档。

## 13. 建议提交拆分

1. `test(ai): cover floating session projection and ordering`
2. `feat(electron): add floating session hub and lightweight window`
3. `feat(ai): publish cross-window session snapshots`
4. `feat(ai): focus sessions from the floating window`
5. `feat(ai): add floating window setting and dual themes`
6. `docs(ai): record floating window verification results`

## 14. 实施结果

已于 2026-07-27 完成首版实现：

- 独立轻量 renderer/preload，不启动第二套 Angular 或 AI 监听；
- 主进程聚合多窗口 Session，并校验所有 IPC 来源和 payload；
- 默认显示最新活动的 3 条，展开后显示全部；
- 点击精确恢复窗口并聚焦目标 Tab / Split Pane；
- 黑白双主题跟随主程序，设置开关默认关闭；
- 顶部提供带 hover/按下反馈的紧凑拖动条；
- Session DOM 按 `sessionId` 增量更新，时间刷新不再整窗重渲染；
- 动态内容高度、隐藏滚动条和独立窗口位置持久化；
- 简体中文和繁体中文设置文案。

实现与原计划的主要差异：

- 普通 renderer 通过 app entry 安装的窄接口 bridge 发布快照，避免 `tabby-ai`
  typings 直接依赖 Electron 专用包；
- 主题和 Session 合并在同一份权威快照中发送；
- Windows 上可交互拖动条使用受限增量移动 IPC，因为原生
  `-webkit-app-region: drag` 会吞掉可靠的 hover 反馈。

验证结果：

- `yarn test`；
- app main、app renderer、tabby-ai TypeScript 检查；
- ESLint JSON formatter 全量检查；
- `yarn build` 整仓构建；
- Windows dev 模式真实启动；
- 黑白两套正式构建产物离屏截图；
- 1–3 条高度、隐藏 footer、阴影边界、拖动条反馈和增量刷新人工验收。
