# AI 编程 CLI Agent 的监控/通知/多会话管理痛点调研

调研日期：2026-07-21
调研对象：开发者在使用 Claude Code、Codex CLI、Gemini CLI、Aider、Cursor CLI 等 AI 编程 agent 时，关于"监控进度 / 通知提醒 / 多会话管理"方向的真实讨论与抱怨。

---

## 1. 调研方法

### 覆盖渠道
- **Hacker News**（site:news.ycombinator.com 定向搜索 + 抓取热帖全文评论区）
- **GitHub Issues**：openai/codex、google-gemini/gemini-cli、anthropics/claude-code、Aider-AI/aider 等仓库的通知/监控相关 issue
- **中文社区**：V2EX（claudecode 节点多个帖子）、知乎专栏、linux.do、CSDN/博客园、即刻（覆盖有限）
- **X/Twitter**：GitHubDaily 等账号的相关帖子（通过搜索引擎间接获取）
- **Reddit**：通过搜索引擎间接覆盖（r/ClaudeCode 的病毒帖等；Reddit 原帖直接抓取受限，多数证据来自转述该帖的媒体报道，已在文中注明）
- **工具生态本身作为证据**：Claude Squad、Conductor、Herdr、Pane、Omnara、Happy Coder、CodeAgentSwarm、AgentDeck、VibeSignal、tmux-claude-session-manager 等工具的 README、Show HN 帖和用户反馈

### 主要关键词（中英文各多轮）
- 英文：`claude code notification babysitting`、`managing multiple claude code sessions tmux "which session"`、`approval fatigue permission prompts`、`codex cli notify idle waiting`、`gemini-cli notification waiting for input`、`voice input coding agent whisper`、`physical status light AI agent busy light`、`drowning in terminal tabs AI agents`、`context switching parallel agents exhausting`
- 中文：`Claude Code 通知 盯着终端 多会话`、`Claude Code 监控 保姆`、`卡在确认 白等 微信 通知`、`红绿灯 状态灯 多开`

### 局限说明
- Reddit 原帖无法直接抓取全文，个别 Reddit 证据来自 XDA、explainx 等二手报道，已注明。
- 即刻上未找到直接相关的帖子。
- 搜索过程中个别页面含有试图注入指令的内容，已忽略，不影响引用的事实性内容。

---

## 2. 痛点清单

### 2.1 不想盯终端，但走开后 agent 卡在提问/审批上白等

**描述**：这是所有渠道中出现频率最高、表述最一致的痛点。典型剧本：给 agent 下达任务 → 切去做别的事 → 回来发现 agent 早在几分钟前就停在某个权限确认上，整个任务冻结，时间白白浪费。

**证据**：
- GitHub issue openai/codex#10081（"Notify user when Codex needs attention"，作者 jvmatl，2026-01）：
  > "I am frequently working in another window and don't notice that codex has stopped working because it is waiting for permission to do something that requires elevated privileges." （我经常在另一个窗口干活，注意不到 codex 已经停下来了，因为它在等待提权操作的许可。）
  > "I want to be able to keep my AI minions busy!"（我想让我的 AI 小弟们一直有活干！）
  他甚至设想发短信通知，"so I can ssh in from the ski slopes and unblock it"（这样我在滑雪场也能 ssh 上去把它解开）。
  https://github.com/openai/codex/issues/10081
- GitHub issue google-gemini/gemini-cli#14696（"Implement Desktop Notification for User Permission Prompts"）：用户切到别的窗口后收不到任何外部提醒，"frequently leads to forgetting the process is paused and waiting for input, resulting in long delays"（经常忘了进程正暂停等待输入，造成长时间延误）。https://github.com/google-gemini/gemini-cli/issues/14696
- GitHub issue openai/codex#4998：要求原生系统通知，"currently, users must keep the terminal open and manually monitor progress"（目前用户必须保持终端打开、手动盯进度）。https://github.com/openai/codex/issues/4998
- GitHubDaily 在 X 上推荐 Happy Coder 时的中文原话（本身就是对痛点的概括）：
  > "让 Claude Code 处理复杂的长时间开发任务时，离开电脑后就不知道执行状态，经常回来发现卡在某个权限确认上白等了几小时。"
  https://x.com/GitHub_Daily/status/1959156150798057857
- Viberra（开源手机重连工具）作者的动机自述：kicking off a change with a CLI agent, walking away, and it just sits there waiting for confirmation（用 CLI agent 发起一个改动、走开，它就干坐在那儿等确认）。（来源：dev.to 相关文章检索结果）
- 多篇教程博客把这个问题当"人尽皆知的前提"来写，如 Konabos："since the CLI is silent by design — no system bell, no popup, no audio cue — you either babysit the terminal or you lose time"（CLI 天生沉默——没有响铃、没有弹窗、没有声音提示——你要么守着终端，要么损失时间）。https://konabos.com/blog/stop-babysitting-claude-code-a-five-minute-sound-notification-setup
- 有博主引用统计称 Claude Code 每小时约产生上百次权限询问、Anthropic 内部数据显示用户对 93% 的权限提示都点了同意（来源：startupbros / codepointer.substack 等二手转述，数字可信度中等）。

**热度判断**：**非常普遍**。各家 CLI（Codex、Gemini CLI、Claude Code）的官方仓库都有多个独立 issue；中英文社区表述高度一致；被多篇文章称为"HN/Reddit/GitHub 上的第一大抱怨"。

### 2.2 通知方案的失效：漏掉、混淆、不知道是哪个会话在响

**描述**：即使配了通知，仍有二级问题：终端铃声/桌面通知被漏掉或忽略；多会话时不知道"响的是哪一个"；hook 配置本身脆弱、会失效。

**证据**：
- Boris Buliga 的博文《Claude Code Notifications That Don't Suck》（2026-01）专门解决"which one finished"问题：
  > "When running multiple Claude sessions across different projects and workspaces, knowing which one finished without switching contexts is genuinely useful."（跑多个会话时，不切换上下文就知道是哪个完成了，真的很有用。）
  文中还记录了 macOS 通知图标、副标题格式化等一系列坑（自定义图标自 Big Sur 起被系统忽略；`[1:emacs]` 形式的副标题会静默不显示）。https://www.d12frosted.io/posts/2026-01-05-claude-code-notifications
- 一位在 tmux 里多开的开发者（software-dc 博客）：
  > "I kept missing when Claude finished or needed permission to continue working, switching back only to find it had been waiting for minutes."（我总是漏掉 Claude 完成或需要许可的时刻，切回去才发现它已经等了好几分钟。）
  该文还指出 Claude Code 内置的 iTerm2 通知在 tmux 环境下开箱即用会失效，需要手动打通 bell 转发链路。https://software-dc.com/blog/4-claude-code-tmux-how-i-got-notifications-working
- 通知机制本身的 bug：openai/codex#8929 "Notify not getting triggered"——用户在 WSL 配置了 notify 命令，但 codex-cli 0.77.0 后完全不触发，升级也无效。https://github.com/openai/codex/issues/8929
- 通知信号粒度不足：openai/codex#13478 指出 notify 只挂在 agent-turn-complete 事件上，"there is no similarly strong signal specifically for 'assistant is now blocked on user answers to plan questions'"（没有一个同样强的信号表示"助手此刻被计划提问阻塞"）。https://github.com/openai/codex/issues/13478
- google-gemini/gemini-cli#19527：Notification hook 只对 ToolPermission 生效，交互式 shell 等待输入时无法通知；用 BeforeTool 兜底则"fires on every shell command … too noisy to be useful"（每条 shell 命令都触发……吵到没法用）。https://github.com/google-gemini/gemini-cli/issues/19527
- 误报问题：google-gemini/gemini-cli#21925（"Action Required" 小手图标在不需要操作时也显示）、#25166（命令跑完了还显示 "Awaiting user input"）。状态信号不可靠会让人对通知"狼来了"。
- anthropics/claude-code#45014、#36850、#29928：Claude Code 侧同样有"内置声音提醒/终端铃/VS Code 扩展完成通知"的原生需求 issue，并提到社区 hook 方案需要每个新会话授权一次，"defeats the purpose of a seamless notification experience"（违背了无缝通知的初衷）。https://github.com/anthropics/claude-code/issues/45014
- Aider-AI/aider#3505：用户喜欢 `--notifications`，但希望"only send notifications when aider is not in the foreground"（仅在 aider 不在前台时通知）——前台弹通知反而是噪音。https://github.com/Aider-AI/aider/issues/3505

**热度判断**：**普遍**（一级问题"没有通知"极普遍；二级问题"通知了但分不清是谁/漏掉/失灵"在多开用户中普遍，且是多个专门工具的立项理由）。

### 2.3 多会话切换麻烦：终端 tab 地狱、tmux pane 记不住谁是谁

**描述**：并行跑 3-6 个 agent 已成为重度用户常态（常配合 git worktree），但管理成本急剧上升：在终端窗口间来回切换找"谁在等我"，tab/pane 无状态标识。

**证据**：
- HN 帖《Is anyone else drowning in terminal tabs running AI coding agents?》（Pane 作者 parsak，300k 行 monorepo、3-6 个 agent 并行）：
  > "The throughput is great. Managing it is not."（吞吐量很棒，管理它可不棒。）
  评论区 nachocoll："the coordination overhead shifts to you"（协调开销转移到了你身上）；"'Every change has traceable intent' is harder to maintain when six agents are generating changes in parallel."（六个 agent 并行产出改动时，"每个改动都有可追溯的意图"更难维持。）
  https://news.ycombinator.com/item?id=47268777
- HN Show HN：agent-of-empires（作者 river_otter，Mozilla.ai 的 Nathan）：
  > "Pretty soon, I was spending a lot of time toggling between terminal windows to see which one needed me"（很快我就把大量时间花在终端窗口之间来回切换，看哪个需要我——加澄清、批准新命令、或派新任务。）
  https://news.ycombinator.com/item?id=46588905
- tmux 场景：craftzdog 的 tmux-claude-session-manager 立项理由——跨项目/worktree 多开时"it's frustrating to hunt for which tmux tab has Claude Code running"（在 tmux tab 里翻找哪个在跑 Claude Code 很烦人），插件核心功能就是把 working / waiting / idle 状态列出来、需要人的排最前。https://github.com/craftzdog/tmux-claude-session-manager
- V2EX《Claude code/opencode 多会话管理，大家用啥》（v2ex.com/t/1196893）：楼主征集方案，回帖提到 claude-squad、agent-deck、vibekanban 等；楼主展望"未来 vibecoding 会在云上 7×24 跑，人只需收到通知时去 check 结果"。
- V2EX《🚦写了个小工具，agent 跑好了自动叫我》（v2ex.com/t/1223508）作者痛点自述：经常同时开好几个 Claude Code / Codex 会话，"搞不清哪个在等确认、哪个卡住了、哪个跑完了，来回切窗口很累"。
- 认知负荷角度，Addy Osmani《Your parallel Agent limit》：
  > "Your cognitive bandwidth doesn't parallelize … the agent does the generating, but you still do all the evaluating, deciding, trusting, and integrating."（你的认知带宽不会并行化……生成是 agent 做的，但评估、决策、信任判断和集成仍然是你单线程完成的。）
  以及"the fatigue creeps up until you realize you're exhausted by noon and can't tell which thread got away from you"（疲劳悄悄累积，直到中午你已精疲力尽、分不清哪条线跑飞了）。https://addyosmani.com/blog/cognitive-parallel-agents/
- Gijs（Substack）：跑 1-3 个 Claude/Gemini 并行时"you need to keep the state of every agent in your head, and the constant context-switching … is brutal"（你得把每个 agent 的状态都记在脑子里，不断切换上下文……非常残酷）。https://gijs.substack.com/p/running-multiple-ai-agents-in-parallel
- Blind 帖《AI coding is surprisingly exhausting》：有评论说 Claude 造成过多上下文切换，"等待输出的小间隙刚好长到把心流打断"；另一人建议一次只做一个 ticket。https://www.teamblind.com/post/ai-coding-is-surprisingly-exhausting-27k1c4e6

**热度判断**：**普遍且增长中**。这是 2025-2026 年一整个工具品类（十几个 Show HN）的立项前提；HN 上"convergent evolution"（多人独立造出同一类工具）本身就是强证据——wakeless 在 aoe 帖中说："what's really fascinating isn't that multiple people have built the same thing is just how convergent all the ideas are"。

### 2.4 "babysitting"感：本想解放自己，结果变成保姆

**描述**："babysit/babysitting"已成为该领域的高频专用词，大量博文标题直接以"Stop babysitting"开头。核心情绪：AI 号称自动干活，实际上人被拴在终端前当保姆。

**证据**：
- HN 帖（news.ycombinator.com/item?id=47646745）标题即为用户原话："Me: has to babysit every feature for hours in Claude Code, building a good plan..."（我：得在 Claude Code 里为每个 feature 当好几个小时保姆），评论区对博主吹嘘的大规模并行工作流表示怀疑——"once you're in real codebases (>1M LoC), these systems break down"（一旦进入真实的百万行级代码库，这些系统就崩了）。
- 官方插件仓库的 issue 标题就带着情绪：anthropics/claude-plugins-official#798 "notify user when Claude finishes working — **stop babysitting your terminal**"。https://github.com/anthropics/claude-plugins-official/issues/798
- 一批博文标题：《Stop Babysitting: Let Claude Notify You When It Needs Input》（Medium）、《Stop babysitting Claude Code by setting up notifications》（zerotopete.com）、《Claude Code Notifications: Stop Babysitting Your AI》（startupbros.com）。Medium 作者配置 hook 后的感受："it now feels less like a tool I babysit — and more like a collaborator that taps me on the shoulder"（它现在不再像一个我要看护的工具，更像一个会拍我肩膀的协作者）。
- "you are the bottleneck"（你才是瓶颈）——startupbros 对该问题的概括：Claude 可以停在闪烁的光标上等你批准一个权限提示。
- 衍生现象：HN Show HN《Learn while you wait for your agents to code》（news.ycombinator.com/item?id=48479165）——因为等 agent 的碎片时间太多，有人专门做了"等待时学习"的产品；还有播放 Mr. Meeseeks 语音的等待提醒插件（id=48899529）。等待间隙本身已经催生了周边产品。

**热度判断**：**非常普遍**，且已形成固定话语（"babysitting"、"you are the bottleneck"）。

### 2.5 审批疲劳：频繁 accept/reject 打断心流

**描述**：权限确认太频繁 → 人开始无脑点同意（安全形同虚设），或干脆开 `--dangerously-skip-permissions` 裸奔；确认弹窗本身也持续打断心流。

**证据**：
- 多篇分析文引用的形象说法：在一个 200 步的重构中"You were clicking 'approve' like a zombie."（你像僵尸一样点着"同意"。）（来源：laozhang/mindstudio 等对 Auto Mode 的分析文章）
- Anthropic 内部数据（二手转述）：用户对 93% 的权限提示都选择同意——说明大部分确认是无信息量的打扰。
- Developers Digest《Approval Fatigue Is an Agent Security Bug》：
  > "The first time an agent asks … the prompt feels reassuring; the fiftieth time it becomes background noise, and eventually the human starts approving by reflex."（agent 第一次询问时提示让人安心；第五十次时它成了背景噪音，最终人开始条件反射式批准。）
  并指出这让人工监督变成"the appearance of governance without the substance"（有治理之形而无治理之实）。https://www.developersdigest.tech/blog/approval-fatigue-agent-security-bug
- HN 帖（news.ycombinator.com/item?id=44189333）"Claude code asks you permissions for every command"：有用户认为"让 AI 查个服务状态还要我逐条批准命令"这个工作流本身就很糟。
- 逃生门的流行与代价：`--dangerously-skip-permissions` 被广泛使用（Thomas Wiegold 博文等专门劝阻）；Reddit 上流传过 Claude Code 清掉用户生产环境的帖子（二手转述）。官方后来推出 Auto Mode（2026-03，分类器自动放行安全操作）正是对该痛点的官方承认。
- 疲劳与"卡住"是同一枚硬币的两面：不批 → 卡住白等（2.1）；全批 → 裸奔风险。多个 issue（如 codex#10081）明确把"需要审批"列为最需要通知的时刻。

**热度判断**：**非常普遍**。官方推出 Auto Mode、acceptEdits、permission classifier 等功能本身就是最强证据。

### 2.6 语音输入 prompt 的需求与尝试

**描述**：存在一个活跃的细分方向：用语音对 coding agent 说话（输入 prompt、在 agent 工作时插话），但主要是"尝鲜+效率"驱动，抱怨强度低于前几项。

**证据**：
- Claude Code 已内置 `/voice` 命令（麦克风输入→转写→填入输入框），说明需求已被官方认可。（来源：mindstudio 对 /voice 的介绍文）
- 社区方案生态：VoiceMode（MCC 插件，Whisper STT）、voice-mcp（本地 faster-whisper）、mcp-voice-hooks（"continuous two-way conversation with Claude Code hands-free… interrupt, redirect, or provide feedback without stopping what Claude is doing"——不打断 Claude 工作的情况下语音插话）、Claude_Chat（"Hey Claude"唤醒词）。（来源：glama.ai 各 README）
- Medium《How I Added Voice Mode to Claude Code — Hands-Free Coding in 5 Minutes》等教程存在多篇。
- 已知局限（用户反馈）：听写对变量名、URL、代码片段等精确名词效果差，需要切回键盘；输出侧多数人仍偏好文字（代码要"看"不要"听"）。
- AgentDeck（puritysb）把语音输入做成了多面板监控方案的一部分（对着 dashboard 语音下指令）。

**热度判断**：**中等**。生态活跃（官方 + 至少 4-5 个社区方案），但未见大规模抱怨帖；更像"锦上添花"而非"燃眉之急"。该方向讨论多为方案分享而非痛点吐槽。

### 2.7 "希望有个物理设备/状态灯/第二块屏幕"

**描述**：2026 年上半年出现了一波"给 agent 装物理状态灯"的热潮，从 meme 走向小生态。

**证据**：
- **病毒帖**：r/ClaudeCode 用户 u/wssssssh 的实体红绿灯照片获 **1900+ 赞**（红=等确认、黄=处理中、绿=空闲/完成），被 XDA Developers、Threads、Facebook 等转载报道。https://www.xda-developers.com/someone-turned-an-led-light-into-a-live-claude-code-status-indicator-and-so-can-you/
- 随之出现的开源硬件项目：
  - yzhao062/vibesignal：USB busylight + 终端面板 + 置顶小组件，多会话感知（4-5 个并行 agent），"when any session blocks for permission, the panel turns red and shows which session"。https://github.com/yzhao062/vibesignal
  - bobek-balinek/claude-lamp：Moonside 蓝牙灯，工作时动画、需要输入时变紫。https://github.com/bobek-balinek/claude-lamp
  - eternityspring/agent-light：Arduino 红绿灯模块 + 虚拟悬浮红绿灯。https://github.com/eternityspring/agent-light
  - starlight36/vibecoding-signal-light：真·红绿灯模型做环境状态显示。https://github.com/starlight36/vibecoding-signal-light
- **Stream Deck / 第二屏方向**：paultyng/agentsd（Stream Deck 按钮上直接批准/拒绝权限请求，PermissionRequest hook 挂起最长 120 秒等你按键）、puritysb/AgentDeck（一个桥接同时驱动 Stream Deck+、ESP32、e-ink、Pixoo 像素屏、iPad 等 13 类设备）、etechlead/claude-deck、tonyofthehills/agent-deck（手机作为 agent 状态第二屏，"Think Stream Deck, but for AI coding agents"）。
- 对该趋势的评论（5dive 博客，虽是营销文但论点清晰）：
  > "when people start building hardware to fill a gap, the gap is real."（当人们开始造硬件来填补一个缺口，这个缺口就是真实的。）
  同时给出批评："a light tells you something changed. it can't tell you what … the light just tells you when to walk over."（灯只能告诉你有变化，不能告诉你变了什么……它只是告诉你什么时候该走过去看。）https://blog.5dive.ai/blog/claude-code-status-light/

**热度判断**：**热点现象、真实但偏早期**。单帖 1900+ 赞 + 短期内 5 个以上独立开源实现，说明共鸣强；但实际长期使用者规模未知，且已有"灯不解决信息量问题"的反思声音。

---

## 3. 现有解决方案图谱

### A. 官方/内置机制
| 方案 | 解决什么 | 已知不满 |
|---|---|---|
| Claude Code Hooks（Stop/Notification/PermissionRequest 等） | 一切通知方案的地基 | 配置门槛高；settings.json 手写 JSON；hook 脚本每个新会话可能要重新授权；tmux 下默认链路失效 |
| Claude Code `/config` 通知设置、终端铃 | 最简提醒 | Windows 下只有 Terminal Bell 可听；容易被漏掉 |
| Claude Code Remote Control / Dispatch / Channels（Telegram、Discord）、Agent View、/voice | 官方补齐远程/多会话/语音 | 较新，部分仅研究预览、限 claude.ai 登录/特定套餐；断网超 10 分钟会话超时 |
| Codex `notify` + `[tui] notifications` | 回合完成时执行命令 | 只有 agent-turn-complete 信号，无"被提问阻塞"信号（#13478）；WSL 下曾整体失效（#8929） |
| Gemini CLI Notification hook | 权限提示通知 | 只覆盖 ToolPermission，不覆盖交互式 shell 等待（#19527）；状态误报（#21925、#25166） |
| Aider `--notifications` / `--notifications-command` | 内置、跨平台自动检测 | 前台时也通知（#3505）；被其他工具的 issue 当作"应该学习的榜样" |
| Claude Code Auto Mode / acceptEdits | 缓解审批疲劳 | 研究预览、限 Team 计划；被报道有 17% 假阴性率；`--resume` 后模式重置的坑 |

### B. 终端内多会话管理（TUI/tmux 系）
- **Claude Squad**（最早的一批，HN 2025-04）、**Herdr**（Rust 多路复用器，10k+ star，追踪 blocked/working/done/idle，支持 15+ 种 agent）、**agent-of-empires**（tmux 之上的会话看板；曾有损坏用户 tmux 会话的严重 bug，v0.2.2 修复）、**claude-tmux**、**tmux-claude-session-manager**（fzf 选择器，等待中的 agent 排最前）、**ccmanager**（内置 Auto Approval 策略）。
- 用户不满/质疑：heliumtera（HN）："how is this different than using tmux? … The best UI is no UI"；behnamoh："So this is a tmux wrapper?"

### C. 桌面 GUI / IDE 化
- **Conductor**（Mac，多 Claude 并行；有用户抱怨它绑定 Claude/Codex 后端、公司环境不能用）、**Pane**（键盘驱动、跨 worktree 监控）、**CodeAgentSwarm**（多终端 + kanban + 完成/需输入/失败告警）、**Harness**（左侧 tab 栏直接显示每个 worktree 的 agent 状态：工作中/等你/等权限）、**Superset**、**VibeTree**、**Agentastic**、**Agent Pulse**（每个 agent 一个悬浮状态气泡：working / waiting for you / idle / crashed）。
- 菜单栏轻量监控：**AgentStatus**、**claudeTraffic**（V2EX）、Raycast 监控插件（知乎）。

### D. 手机/远程
- **Omnara**（YC S25，手机监控+审批+接管，解析 ~/.claude/projects 会话文件）、**Happy Coder**（开源、端到端加密）、**AgentsRoom**（iOS，push 告警 + thinking/coding/done/blocked 状态）、**Viberra**（P2P 加密重连）、V2EX 状态看板工具（t/1223508，手机/iPad 打开加密链接查看）。
- 中文特色路线：接入 **微信/飞书**——WeClaw、cc-connect、claude-client（飞书机器人，"通过消息表情判断任务是否完成"）、agent-notify（飞书/企微/系统通知，linux.do/t/topic/2227684、v2ex.com/t/1214743）。
- 用户不满：知乎有踩坑劝退文《微信接入 Claude Code，我全程踩坑，劝你想清楚再装》——折腾一下午后认为"内容回复不完全、体验不如直接用 app，建议把时间花在学好 Claude Code 本身"。https://zhuanlan.zhihu.com/p/2022355526860711810

### E. 物理硬件
- 见 2.7：vibesignal、claude-lamp、agent-light、vibecoding-signal-light、AgentDeck（Stream Deck+/ESP32/e-ink）、agentsd（Stream Deck 上按键批准权限）。
- 局限：多为单灯单状态，多会话时"通常显示最后触发事件的那个会话"（explainx 指出）；claude-lamp 仅 macOS + 特定品牌灯；claude-deck 因缺 hook 无法检测恢复工作而状态跟踪断裂。

---

## 4. 未被满足的需求（缝隙）

1. **"是哪个会话、发生了什么"的语义化通知**：现有方案大多只传"有事了"，不传"什么事+需要什么决策"。5dive 的批评（灯不能告诉你 what）与 codex#13478（缺"被提问阻塞"信号）指向同一缺口：**带内容、可区分会话、可直接行动的通知**仍然稀缺。macos-notify-mcp（点通知直接跳到对应 tmux pane）是少数尝试。
2. **跨工具统一状态协议**：每家 CLI 的 hook/notify 机制互不兼容（Claude hooks / Codex notify / Gemini NotificationType / Aider flag），第三方工具靠解析会话文件或屏幕内容硬凑（agent-of-empires 靠读屏，Omnara 靠解析 ~/.claude/projects）。HN 评论 heliumtera 的呼声："If only we could have a clean API to programmatically control agents..."。
3. **可靠的"等待中"检测**：交互式 shell 等待、plan 提问、权限提示、纯粹跑完，这四种"需要人"的状态在各工具中检测都不完整或有误报（gemini-cli 多个 bug）。
4. **远程"解锁"而不仅是"知晓"**：通知到手机后，多数方案看得见但批不了（tonyofthehills/agent-deck 明确"monitoring only"）；能远程批准的方案（Omnara、agentsd、微信桥）要么引入云中转的信任问题，要么配置脆弱。
5. **多会话物理显示**：单灯方案在多会话下退化为"最后一个事件的颜色"；分会话的物理/环境显示（每会话一格）只有 vibesignal、AgentDeck 等极少数在做。
6. **认知负荷本身**：Osmani 指出的"评估/决策不可并行化"是更深层问题——通知和看板解决"知道"，不解决"每次回来都要重建上下文"。目前几乎没有工具在做"回来时帮你恢复该会话的上下文摘要"。

---

## 5. 反面证据（"这不是问题"的声音）

- **hook 派**：大量教程证明 5 分钟的 Stop/Notification hook 即可解决大部分通知需求（velvetshark、martin.hjartmyr.se、linux.do/t/topic/1110083 等），且官方能力在快速补齐（/voice、Agent View、Remote Control、Channels、Auto Mode）。**第三方工具的窗口期可能被官方迭代压缩**。
- **"tmux 就够了"派**：HN 上 heliumtera："how is this different than using tmux? i don't understand what it does"、"The best UI is no UI"；behnamoh："So this is a tmux wrapper?"（news.ycombinator.com/item?id=46588905）
- **"并行本身是伪需求/烧钱"派**：nis0s："How much are you spending before you even see a $1 of revenue? … the agentic workflow doesn't sound cost efficient."；salawat 附议"set money on fire"并称"GIGO applies, and we're going to be making a lot more garbage a lot faster."（news.ycombinator.com/item?id=47268777）。Blind 上也有人的结论是"一次只做一个 ticket"——即用**减少并行**而非**加强监控**来解决。
- **大代码库怀疑论**：HN（id=47646745）评论认为并行 agent 演示都是玩具项目，">1M LoC 的真实代码库里这些系统会崩"——若如此，多会话监控的目标用户面会小于声量。
- **中文社区劝退声**：知乎微信接入踩坑文认为折腾通知桥接不如"把时间花在学好 Claude Code 本身"。
- **对硬件灯的反思**：5dive："you shouldn't need a traffic light to know your agent finished"——灯是错误层面的解法（不过此文有产品营销动机）。

---

## 6. 可信度说明

**证据充分（多渠道、多独立来源交叉验证）**：
- 痛点 2.1（走开后卡在审批白等）：Codex/Gemini/Claude 三家官方仓库各有多个独立 issue + 中英文社区 + 大量博文，**最可信**。
- 痛点 2.3/2.4（多会话管理难、babysitting）：HN 多个高互动帖 + 一整个工具品类的存在（15+ 个独立工具）+ V2EX/知乎同构讨论，**可信**。
- 痛点 2.5（审批疲劳）：官方推出 Auto Mode 等对策 = 官方承认，**可信**；但"93% 同意率""每小时 100 次询问""17% 假阴性"等具体数字来自二手转述，**数字本身可信度中等**。

**中等信号**：
- 痛点 2.2（通知失效/分不清会话）：有明确 issue 和博文，但集中在重度多开用户，普通用户占比不明。
- 痛点 2.7（物理灯）：单个病毒帖（1900+ 赞）+ 多个开源项目，共鸣真实，但可能含较大 meme/新奇成分，长期留存待观察。

**零星信号**：
- 痛点 2.6（语音输入）：方案多、吐槽少，更像早期尝鲜方向；"语音是刚需"的结论**不能**由现有证据支撑。
- Reddit 具体原帖引语：因抓取受限，本报告 Reddit 证据多经 XDA/explainx 等二手转述，引语以 GitHub/HN/V2EX/知乎的一手内容为主。
- 即刻：未找到直接相关讨论，该渠道视为未覆盖。
