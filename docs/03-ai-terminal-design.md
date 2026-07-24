# vibby AI 终端：设计定稿

> 定稿日期：2026-07-24 ｜ 形成方式：grilling 问答，7 个决策逐一确认
> 上游文档：`01-pain-points.md`（痛点调研）、`02-solution-fit.md`（VibeDeck 硬件评审）、`rebranding.md`（品牌化触点地图）

## 0. 一句话定位

vibby = **为 AI 编程 CLI 特化的终端**：自动发现本机的 AI CLI、一键开会话、实时监听每个会话在干嘛、该人出手时提醒人——软件本身独立成立，USB/蓝牙硬件（VibeDeck 方向）是下游可选外设。

本方案与 02 评审的关系：把评审中得分最高的"daemon + 状态协议"（8 分）塞进终端本体。vibby 自己就是 PTY 宿主，天然持有输入输出流、控制启动环境，正面化解了评审的头号风险 K1（第三方 daemon 解析他人 TUI 输出的"沼泽"）。

---

## 1. 七个已确认的决策

### D1. 产品定位：独立产品（非硬件宿主）

vibby 对没有硬件的用户必须有完整价值（状态一览、通知、多会话管理）。理由：调研 2.1–2.4 软件侧痛点证据最强，2.7 硬件热度"meme 成分待观察"；软件版是免费的付费意愿试金石；没有装机量硬件就没有获客渠道。

### D2. 事件采集：统一事件模型 + 每 CLI 适配器分层取源

- 定义一套 vibby 内部统一事件模型（见 §2），每个 CLI 一个适配器，适配器自选最可靠的信号源，事件标注置信度：
  - **hook 来源 = high**：Claude Code hooks（PreToolUse/Stop/Notification…），vibby 拉起进程时自动注入配置，用户零配置——直接回应调研 2.2"hook 配置门槛高"的抱怨；
  - **终端控制序列 = low**：标题变更、bell、OSC 通知本来就流经 vibby 的 PTY 层，作为无 hook CLI 的免费兜底；
  - **PTY 输出启发式 = low**：最后手段，宁缺毋滥。
- **MVP 只做 Claude Code 适配器**。原则："少而真"优于"多而谎"（K1 教训：状态会说谎的监控比没有更糟）。

### D3. CLI 类别：标准 ProfileProvider，注册表驱动

- CLI profile 本质是"带 AI 元数据的本地终端 profile"：底层复用 tabby-local 的 PTY 会话，多一个 `aiCli: { kind, version }` 字段，该字段即事件适配器的挂载开关。终端能力（分屏、配色、恢复）全部免费继承。
- 扫描器数据驱动：已知 CLI 注册表（二进制名、探测命令、版本参数、图标、适配器类型）。新增支持一个 CLI = 注册表加一行。
- 扫描时机：启动扫一次 + 设置页手动"重新扫描"，不做常驻监听。
- 首发注册表：Claude Code、Codex CLI、Gemini CLI、OpenCode、Aider、pi。**探测广、适配窄**：全部可探测可启动，但只有 Claude Code 有事件监听，其余卡片如实标注"仅启动，无状态监听"。

### D4. Home 重生为 Dashboard（废弃上游 StartPage）

- 上游 StartPage 只在 `app.tabs.length == 0` 时渲染（`appRoot.component.pug:110`），与"会话开着才需要监控"自相矛盾，废弃。
- 新 Dashboard 为常驻可回访的 Home：标签栏固定 home 图标，随时可回；启动时默认落在此页（取代"自动开默认终端"，留配置项）。
- 内容两区：① 已安装 CLI 卡片（一键开会话）；② 运行中 AI 会话卡片（状态色 + 实况字幕，点击跳转对应 tab）。
- UI/UX 整页重新设计，不受上游样式约束（实现阶段专项做）。上游侵入点仅 `appRoot` 一行条件，主体全部在自有插件包内。
- **这个 Dashboard 就是 02 文档验证路径第 1 步的"虚拟灯条"**：每会话一格、状态分色、needs-you 置顶。第 4 周留存数据是将来开模做硬件的判据。卡片信息结构按"灯格"语义设计，软硬件共用。

### D5. 事件模型：四态状态机 + 细粒度事件流（两层分离）

**会话状态机**（互斥，软件卡片用色的依据）：

| 状态 | 含义 |
|---|---|
| `working` | agent 在干活（thinking / 生成 / 跑工具不在顶层区分） |
| `needs-you` | 阻塞在人身上：审批、plan 提问、交互输入（顶层刻意不细分，细分放事件 payload——调研缝隙 #3：细分状态各家检测都不全，粗粒度才做得对） |
| `idle` | 回合结束，等下一条指令 |
| `error` | 进程异常退出 / 适配器判定崩溃 |

**事件流**（`thinking-started`、`tool-call`、`permission-request`、`turn-completed`…），每条带 `sessionId`、时间戳、置信度，以及一个**为小屏设计的 `summary` 限长短文本字段**（如 `edit: auth.ts`、`bash: npm test`），直接可显示。

**硬件消费的是降维投影**（用户修正后的定稿）：
- 灯只有一个语义：闪烁 = "该你了"。触发条件 = 状态机 `working → 其他任何状态` 的跳变。needs-you/idle/error 不在灯上区分。
- 硬件主角是小屏事件字幕：滚动显示各 CLI 正在干嘛——"眼角余光里的实况字幕"。
- 已知限制：Claude Code hooks 不暴露 thinking 内容。`tool-call` 字幕从 PreToolUse hook 拿（结构化、高置信度、必做）；thinking 摘要需解析 `~/.claude/projects/` 会话 transcript（JSONL）尾部或 PTY 兜底，定位为**尽力而为的增强项**。

### D6. 硬件通道：应用内直连（Web Serial / Web Bluetooth），无桥接进程

- Electron 的 Chromium 内核自带 Web Serial / WebHID / Web Bluetooth——**零原生模块、零独立桥接进程**（此前方案 B/C 的"外置总线 + 桥接进程"因此取消）。
- 事件总线只作为应用内服务存在（RxJS observable，Dashboard 本来就靠它驱动）；"设备输出"是总线的一个内置订阅者，按 JSON 行协议下发。
- 设置页"连接设备"按钮 → 系统级设备选择器 → 配对即用。
- **蓝牙约束（对固件设计的硬要求）**：Web Bluetooth 仅支持 BLE（GATT），不支持经典蓝牙 SPP。固件按 **BLE（Nordic UART Service 风格自定义特征值）+ USB CDC 串口** 双模设计，同一套 JSON 行协议。ESP32 类芯片开箱支持。Windows 10+ 可用。
- 对外 WebSocket / 开放协议：降级为将来可选功能。内部事件模型定义干净，将来加出口不需返工。

### D7. 里程碑：三段可独立交付

- **M1｜能扫能开**：CLI 注册表 + 扫描器 + `AiCliProfileProvider` + Dashboard 骨架（常驻 home 图标、CLI 卡片一键开会话）。无事件监听，但产品门面立住。
- **M2｜能看能提醒**（软件价值核心）：统一事件模型 + Claude Code 适配器（自动注入 hooks）+ 会话卡片实况（四态 + 字幕）+ attention 桌面通知。留存数据从此采集。
- **M3｜能连硬件**：Web Serial/BLE 设备输出 + 配对 UI + 闪烁脉冲与小屏字幕下发。
- 品牌化基础工程（遥测摘除、更新源改向，见 `rebranding.md` §1.2/1.3）与 M1 并行，任何公开发布前必须完成，不阻塞功能开发。

---

## 2. 代码组织约定

- 新功能整体装入**一个新插件包**（建议名 `vibby-ai`，形态与 tabby-* 插件一致：NgModule + DI providers），对上游文件的侵入控制在个位数行（appRoot 的 StartPage 条件、内置插件清单注册）。
- 遵循 `rebranding.md` §3 的合并纪律：功能开发不顺手重构上游代码；vibby-ai 包本身与上游零交集，合并冲突面≈0。
- 事件模型类型定义单独成文件（协议 v0 的雏形），从第一天起当作对外协议的严谨度来写。

## 2.5 Dashboard UI 定稿（2026-07-24 第二轮 grilling + 三版 demo 比稿）

- **选定方向：V3「值机看板」**（`docs/demo/dashboard-v3.html`）：抛弃卡片网格，全宽行看板——每行 = 大号彩色状态字 + CLI 图标/会话名 + 通栏等宽字幕 + 时长；板头为彩色计数行（1 等你 / 2 运行 / …）；CLI 启动区收为底部"站台条" chip 横排。空状态 = 计数归零 + 空板提示行 + chip 居中。
- 过程决策：骨架上下两区、会话主角（needs-you > working > idle 排序硬规则）；卡片信息密度 = 紧凑基态 + hover 浮出最近事件 feed；视觉完全跟随 Tabby 主题系统，四态映射 ANSI 色位（黄=等你、蓝=运行、绿=空闲、红=异常），全板只有 needs-you 有动效。落选方案 V1/V2 保留在 `docs/demo/` 备查（V2 的"注意力横幅"可作为将来杂交候选）。
- **图标：`@lobehub/icons` 系列**（AI 品牌图标库）。已确认覆盖：claudecode / codex / geminicli / opencode / pi（含 color 变体；单色图标暗底需反白处理）；Aider 无图标，字母兜底。实现时装 npm 包（或内嵌所需 SVG），demo 阶段走 unpkg CDN。注意品牌 logo 的商标使用规范。
- **多语言**：所有 UI 字符串走 Tabby 的 ngx-translate/locale 体系（英文原文为 key）；状态词按 locale 提供短词表（zh：等你/运行/空闲/异常/未监听），状态列宽与 CJK letter-spacing 随 locale 调整；事件 `summary` 的动词前缀（edit/bash/think）保持英文不译，自由文本部分跟随会话内容。

## 3. 悬而未决（后续再议）

- 事件 `summary` 的语言策略（跟随界面语言 or 固定英文短语）
- thinking 摘要的 transcript 解析实现与降级策略
- 更多 CLI 适配器的优先级（视各家 hook 能力演进）
- 对外开放协议的时机与形态
- 硬件配对的安全细节（BLE 配对模型即系统层，暂不额外加 token）
