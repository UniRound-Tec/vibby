# WSL 多运行目标支持计划

> 制定日期：2026-07-27
> 上游调研：[`11-wsl-runtime-research.md`](11-wsl-runtime-research.md)
> 状态：已实施（普通 WSL 终端中的手动 CLI 全监听按约定暂缓）

## 实施结果（2026-07-27）

已交付：

- Windows native 与多个 WSL 发行版的独立扫描、版本和路径记录；
- Dashboard 保持一个 CLI 一张卡，在启动/安装 modal 中选择运行环境；
- WSL 目标使用 Linux 安装 recipe，并只以同一目标的重扫结果判定安装成功；
- 排除从 WSL PATH 继承的 `/mnt/c/...` Windows CLI，避免重复检测；
- Dashboard/profile 直启的 WSL Claude Code 和 OpenCode 全监听桥接；
- WSL 1、WSL 2 NAT 和 mirrored networking 的安全连接路径；
- Windows-only WSL 设置区和按发行版启用/排除。

与原计划的实现偏差：

- 当前启动和显式重扫都会扫描所有启用的 WSL 发行版，因此 stopped 发行版会被
  WSL 按官方行为唤醒；这样 Dashboard 可以明确区分“未安装”，而不是保留无法
  操作的 unknown 状态；
- 没有先改造公共 `ShellProvider` 或引入大型 `CliRuntimeService`；官方 WSL 枚举、
  argv/path/network 兼容逻辑集中在 `tabby-ai/src/runtimeTargets.ts` 和扫描器中，
  避免扩大本次跨包改动面；
- 普通 WSL 终端里手动输入 CLI 不注入 shim，也不宣称全监听；仅 Dashboard/profile
  创建且携带 target metadata 的会话启用跨边界监听。

## 0. 目标与首版边界

把 CLI 从“宿主机上唯一的一份安装”改成“可存在于多个运行目标中的安装”：

- Windows：扫描 Windows native，以及启用的 WSL 发行版；
- Linux：只扫描 Linux native；
- macOS：只扫描 macOS native；
- 同一个 CLI 在 Windows、Ubuntu、Debian 中可以有不同路径和版本；
- Dashboard 仍然一个 CLI 一张卡，启动和安装 modal 负责选择运行目标；
- WSL 中只把 Linux 文件系统里的 CLI 算作 WSL 安装，不能重复认领从 Windows
  PATH 继承进来的 `/mnt/c/...` CLI；
- 任何单个 WSL 发行版失败、超时或未扫描，都不能抹掉其他运行目标的结果。

首版交付“发现、启动、安装和诚实的监听能力标记”。Dashboard/profile 直启的
Claude Code 与 OpenCode 已通过跨边界桥接升级为 full monitoring；其他 CLI 以及
普通 WSL 终端中的手动启动仍显示“仅启动”。

首版明确不做：

- SSH、容器、Dev Container 等非 WSL 远端运行目标；
- 在任意普通 WSL shell 中手动键入 CLI 后的自动发现和 shim 注入；
- 自动安装 WSL 本身或自动创建发行版；
- 扫描后调用 `wsl --terminate` 恢复原状态；
- 把 `docker-desktop` 等基础设施发行版默认当作用户开发环境。

## 1. 已定位的现状

### 1.1 已有 WSL 基础

`tabby-electron/src/shells/wsl.ts` 已有 `WSLShellProvider`：

- 只在 Windows 提供 WSL shell；
- 能提供默认发行版和各个具名发行版的终端 profile；
- profile 已使用 `wsl.exe -d <name>`；
- 当前通过 `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` 私有注册表结构
  枚举发行版，并由 flags 推断 WSL 版本；
- `Shell.fsBase` 会被填充，但当前仓库没有消费它。

这说明 PTY 和终端显示本身不需要重新实现；缺的是稳定的运行目标元数据，以及
`tabby-ai` 对它的消费。

### 1.2 当前 AI 扫描模型只能容纳一份安装

`tabby-ai/src/api.ts` 的 `DetectedCli` 只有：

- registry entry；
- 一个绝对 command；
- 一个 launcher；
- 一个 version。

`CliScannerService` 每个 registry entry 只返回第一个命中；Dashboard 和设置页又按
`entry.id` 建单值映射。因此即使增加 WSL lookup，第二个环境也会覆盖或丢失。

扫描器还有两个需要一起修正的行为：

- 全部 entry 被包在一个 5 秒 `Promise.race` 中，一个慢目标可令整轮结果退回空数组；
- `scanResults` 只有“检测到”的数组，无法表达 stopped 发行版尚未唤醒、
  单个发行版失败或 WSL 不可用。

### 1.3 当前启动和安装都按宿主平台推导

`AiCliProfileProvider` 直接把 `DetectedCli.command` 包成宿主进程命令；
`CliInstallModalComponent` 则使用 `process.platform` 选择 recipe 和 shell。

这会导致两个错误：

- Windows 主机中的 Ubuntu 目标仍可能拿到 PowerShell recipe；
- Linux cwd 被写进 `SessionOptions.cwd` 后，`tabby-local` 会在 Windows 文件系统
  上用 `existsSync` 检查并丢弃它。

WSL 启动必须把 Linux command/cwd 放进 `wsl.exe` argv，把 node-pty 的宿主 cwd
保持为有效 Windows 路径或 `null`。

### 1.4 当前 full monitoring 不能直接假设跨 WSL 可用

Claude/OpenCode 监听目前依赖：

- Windows/POSIX 临时目录；
- 当前宿主平台决定的 PATH shim；
- 直接修改 profile args/env；
- Windows 进程树做普通终端 runtime detection；
- Windows renderer 与 CLI 之间的 loopback HTTP/SSE。

WSL 中的 Linux 进程不在 Windows 进程树里；Windows 临时路径和 `pathPrefix` 也
不是 Linux PATH。OpenCode 还涉及 Windows 与 WSL 的端口命名空间，Claude hook
则涉及 settings 文件路径和 WSL 到 Windows callback 的可达性。因此“能通过
`wsl.exe` 启动”不等于“已经全监听”。

### 1.5 本机验证

本机目前有：

- `Ubuntu-22.04`，WSL 2，默认发行版；
- `docker-desktop`，WSL 2。

Ubuntu 登录环境会把 Windows PATH 追加进 Linux PATH。本机实测：

- Claude、Codex、Gemini、Pi 被解析到 `/mnt/c/...` 下的 Windows 安装；
- Grok 被解析到 `/home/jesse/.local/bin/grok`，是真正的 WSL-local 安装；
- `wslpath -w /home/...` 返回 `\\wsl.localhost\Ubuntu-22.04\...`；
- `wslpath -w /mnt/c/...` 返回 `C:\...`。

因此“解析到路径后检查文件系统归属”是正确性要求，不是优化项。

## 2. 定稿决策

### 2.1 宿主平台与运行目标分开

```ts
export type CliRuntimeTarget =
    | {
        id: 'native'
        type: 'native'
        platform: 'windows' | 'linux' | 'macos'
        label: string
    }
    | {
        id: string // `wsl:${encodeURIComponent(distro)}`
        type: 'wsl'
        platform: 'linux'
        label: string
        distro: string
        wslVersion: 1 | 2 | null
        isDefault: boolean
        state: 'running' | 'stopped' | 'unknown'
    }
```

关键不变量：

- `hostPlatform` 决定能否枚举 WSL；
- `target.platform` 决定使用哪套 CLI 安装 recipe；
- `target.type` 决定如何捕获命令、启动 PTY、处理 cwd 和注入监听；
- WSL 1/2 只是发行版属性，不形成另一层 UI 分组。

### 2.2 扫描结果必须表达未知状态

```ts
export type CliTargetScanState =
    | 'detected'
    | 'missing'
    | 'not-scanned'
    | 'failed'

export interface DetectedCli {
    entry: AiCliRegistryEntry
    target: CliRuntimeTarget
    command: string
    launcher: AiCliLauncher
    version: string | null
    monitoring: 'full' | 'launch'
}

export interface CliScanSnapshot {
    targets: CliRuntimeTarget[]
    detections: DetectedCli[]
    targetStates: Record<string, {
        state: 'scanned' | 'not-scanned' | 'failed'
        diagnostic?: string
    }>
}
```

`missing` 只能由已完成的目标扫描得出。stopped 发行版如果按策略没有唤醒，必须是
`not-scanned`，UI 显示“尚未扫描”，不能显示“未安装”。

### 2.3 一个深运行时模块统一平台差异

新增 `CliRuntimeService` 作为扫描器、profile 和安装 modal 共用的 seam：

```ts
export interface RuntimeCommand {
    executable: string
    args: string[]
    cwd?: string | null
    env?: Record<string, string>
}

export interface CapturedCommand {
    status: 'completed' | 'failed' | 'timeout' | 'cancelled'
    exitCode: number | null
    stdout: string
    stderr: string
}

export interface HostProcessSpec {
    command: string
    args: string[]
    cwd: string | null
    env: Record<string, string | undefined>
    shellType: 'unix' | 'powershell' | 'cmd' | null
}

class CliRuntimeService {
    listTargets (policy: 'startup' | 'explicit'): Promise<CliRuntimeTarget[]>
    capture (
        target: CliRuntimeTarget,
        request: RuntimeCommand,
        signal?: AbortSignal,
    ): Promise<CapturedCommand>
    prepare (
        target: CliRuntimeTarget,
        request: RuntimeCommand,
    ): Promise<HostProcessSpec>
}
```

实现内部有两个真实 adapter：native 与 WSL。调用者不拼 `wsl.exe` 参数、不猜
编码、不转换 `/mnt/c`、不判断 shell 类型。删除此模块后，这些知识会重新散落到
scanner/profile/installer/monitoring 四处，因此这个 seam 有足够深度。

### 2.4 发行版发现复用终端提供层，但改用官方兼容读取

不让 `tabby-ai` 再私自维护一套 Lxss 注册表解析。计划调整公共 `Shell` 元数据：

```ts
interface Shell {
    // existing fields...
    runtime?: {
        type: 'wsl'
        distro: string
        wslVersion: 1 | 2 | null
        isDefault: boolean
        state: 'running' | 'stopped' | 'unknown'
    }
}
```

`WSLShellProvider` 内部增加单一 `WslDistributionEnumerator`，按调研结论执行：

1. `WSL_UTF8=1 wsl.exe --list --quiet` 取得名称集合；
2. `WSL_UTF8=1 wsl.exe --list --running --quiet` 取得运行集合；
3. `WSL_UTF8=1 wsl.exe --list --verbose` 只补版本和默认标记；
4. verbose 解析失败时仍保留名称，未知字段为 `null/unknown`；
5. 保留 UTF-16LE fallback，不解析本地化错误文本。

`tabby-ai` 通过已有 `ShellProvider[]` 注入读取 `runtime`，不直接依赖
`tabby-electron` 具体类。

### 2.5 自动扫描策略

为避免把未扫描目标错误显示成“未安装”，启动和用户点击 Rescan 都会：

- 扫描 native；
- 扫描所有启用的 WSL 发行版，包括 stopped；
- 明确接受 stopped 发行版会被 WSL 启动；
- 不在完成后调用 `wsl --terminate`。
- 默认排除已知基础设施发行版（首批 `docker-desktop`、
  `docker-desktop-data`），设置页允许用户重新启用。

如果后续实际体验证明默认发行版冷启动仍太重，可以把“启动时扫描默认 WSL”改成
设置项；数据模型无需再变。

### 2.6 Dashboard 与 modal

Dashboard 保持一个 CLI 一张卡：

- 单环境：`Windows · 0.145.0` 或 `Ubuntu-22.04 · 0.146.0`；
- 多环境：`Windows + Ubuntu-22.04 +1`；
- 只有未知目标：显示“WSL 尚未扫描”，不显示“点击安装”；
- 全部已扫描且都 missing：才显示“点击安装”。

点击已安装卡进入启动 modal。modal 顶部增加运行环境选择器，行内显示：

- Windows / 发行版名称；
- WSL 1/2；
- CLI 版本；
- `全监听` 或 `仅启动`。

默认选择顺序：

1. 该 CLI 上次使用且仍检测到的目标；
2. native；
3. 默认 WSL 发行版；
4. 其余按名称排序。

点击未安装卡进入安装 modal。Windows 主机中展示 native 和启用的 WSL 目标；
选 WSL 时使用 Linux recipe。`requires-wsl` 的 Windows recipe 不再只是死提示：
有可用发行版时直接引导到 WSL 目标，没有发行版时才显示 WSL 前置条件。

### 2.7 cwd 规则

启动 modal 的 cwd 与目标联动：

- native：保持现有逻辑；
- WSL Linux 路径（`/` 或 `~` 开头）：原样传给 `wsl.exe --cd`；
- Windows 绝对路径：原样传给 `--cd`，让 WSL 按该发行版配置转换；
- `\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...`：
  - 同发行版才接受并转换为内部 Linux 路径；
  - 跨发行版明确报错；
- 不手写 `/mnt/c`；
- 无 cwd 时显式 `--cd ~`，不继承 Vibby 进程当前目录。

`SessionOptions.cwd` 对 WSL 保持为有效宿主 cwd 或 `null`；Linux cwd 只存在于
`wsl.exe` argv 和 `aiCli` metadata 中，避免 Windows `existsSync` 丢弃它。

## 3. 实施工作包

### WP0：模型与纯函数闸门

修改：

- `tabby-ai/src/api.ts`
- 新增 `tabby-ai/src/runtimeTargets.ts`
- 测试脚本和 `tabby-ai/package.json`

工作：

- 引入 target、snapshot、monitoring capability；
- 增加稳定 target id 编解码；
- 增加按 CLI 聚合、默认目标选择、卡片摘要纯函数；
- 先写多目标、unknown state 和 native-only 平台回归测试。

验收：

- 旧 native detection 可无损映射到 `target.id === 'native'`；
- 同一 CLI 的三份安装不会互相覆盖；
- Linux/macOS snapshot 中不可能出现 WSL target。

建议提交：`refactor(ai): model CLI runtime targets`

### WP1：共享 WSL 发行版枚举

修改：

- `tabby-local/src/api.ts`
- `tabby-electron/src/shells/wsl.ts`
- 新增 `tabby-electron/src/shells/wslDistributions.ts`
- 对应纯测试

工作：

- 给 `Shell` 增加可选 runtime metadata；
- 把 WSL 管理命令、编码、表格解析集中到 enumerator；
- 具名 WSL shell 填入 distro/version/default/state；
- 默认 alias 与具名发行版按 distro 去重；
- WSL 不可用或无发行版时返回结构化 availability，不抛到整个 profile 列表。

验收：

- UTF-8、UTF-16LE、Unicode/空格名称和本地化 state fixtures；
- quiet 成功但空列表能区分“无发行版”；
- verbose 失败仍能从 quiet/running 产生可用目标；
- 非 Windows 不执行任何 WSL 子进程。

建议提交：`feat(local): expose WSL runtime metadata`

### WP2：实现深运行时模块

修改：

- 新增 `tabby-ai/src/services/cliRuntime.service.ts`
- 新增 WSL argv/cwd/path 纯函数和测试

工作：

- native adapter 收拢现有 `wrapCommand`、PATH 和进程树终止逻辑；
- WSL adapter 统一构造
  `wsl.exe --distribution <name> --cd <cwd> --exec <program> <args...>`；
- 所有 argv 独立传递，禁止拼用户输入 shell 字符串；
- 实现每命令 timeout、AbortSignal、stdout/stderr 上限和退出分类；
- WSL 管理命令设置 `WSL_UTF8=1`；
- 单个 probe 超时只杀本次 wrapper，不 terminate 整个 distro。

验收：

- 发行版名、路径和参数含空格/Unicode/引号均保持 argv 边界；
- Windows cwd、Linux cwd、同/跨发行版 UNC 矩阵；
- timeout/cancel 不影响其他目标；
- native Windows/macOS/Linux 既有包装保持一致。

建议提交：`feat(ai): add target-aware CLI runtime`

### WP3：目标感知扫描

修改：

- `tabby-ai/src/services/cliScanner.service.ts`
- `tabby-ai/src/scanLifecycle.ts`
- `tabby-ai/src/binaryResolution.ts`
- 对应 scanner/runtime tests

工作：

- native 和 WSL target 并发扫描，但限制 WSL 冷启动并发；
- 用每目标 settle 代替全局 all-or-nothing 5 秒 fallback；
- WSL login shell 运行固定 registry probe，使用 ASCII sentinel 过滤 banner；
- 对 alias/function、非文件结果和版本失败分别分类；
- 对命中路径执行 realpath 和 `wslpath -w` 归属校验；
- `C:\...` 结果视为 inherited Windows 安装，不计入 WSL；
- `\\wsl.localhost` / `\\wsl$` 且发行版一致才计入 WSL；
- refresh 支持只重扫安装目标，也支持 explicit 全量重扫。

验收：

- 本机只能把 `/home/jesse/.../grok` 算作 Ubuntu 安装；
- `/mnt/c/.../claude|codex|gemini|pi` 不产生重复 WSL detection；
- nvm/mise/asdf、banner、坏 rc、超时、输出过量 fixtures；
- 一个 distro 失败仍保留 native 和其他 distro 结果；
- startup 与 explicit 的 stopped policy 正确。

建议提交：`feat(ai): scan CLIs across WSL distributions`

### WP4：目标感知启动与恢复

修改：

- `tabby-ai/src/profiles.ts`
- `tabby-ai/src/components/cliLaunchModal.component.*`
- `tabby-ai/src/api.ts`

工作：

- builtin profile 仍保持 `ai-cli:<kind>`，不为每个发行版复制 profile；
- modal 返回 target id、cwd、name 和 args；
- 由 `CliRuntimeService.prepare()` 生成最终 SessionOptions；
- `aiCli` metadata 持久化 target ref 和 target cwd；
- 上次目标偏好保存为轻量配置；
- 恢复 token 继续启动原目标；目标消失时显示明确失败，不静默切到 native。

验收：

- Windows、Ubuntu、Debian 三目标选择和版本显示；
- `wsl.exe` 最终 argv 与选择一致；
- native cwd、Windows cwd、Linux cwd、UNC cwd；
- profile selector 和 Dashboard 共用同一个 modal；
- 重启恢复不改变 distro。

建议提交：`feat(ai): launch CLIs in selected runtime`

### WP5：目标感知安装

修改：

- `tabby-ai/src/installRecipes.ts`
- `tabby-ai/src/components/cliInstallModal.component.*`
- 安装 recipe/runtime tests

工作：

- recipe 由 `target.platform` 选择；
- WSL 目标在嵌入终端中执行 Linux recipe；
- 安装 terminal 由 runtime service 生成 PTY spec；
- 安装成功后只刷新所选目标；
- success 判定必须命中同一 CLI + 同一 target；
- WSL unavailable/no distro/target failed 分别显示，不匹配本地化 stderr；
- WSL 安装环境同样过滤 Yarn lifecycle `npm_config_*` 污染。

验收：

- Cursor/OpenHands 在 Windows native 不可装、在 Ubuntu 可走 Linux recipe；
- Windows 安装不能错误满足 Ubuntu 的 success；
- Ubuntu 安装不能被 Windows PATH 继承命中误判成功；
- 失败、重试、取消不会终止发行版。

建议提交：`feat(ai): install CLIs into selected runtime`

### WP6：Dashboard、设置和文案

修改：

- `tabby-ai/src/components/dashboardTab.component.*`
- `tabby-ai/src/components/aiSettingsTab.component.*`
- `tabby-ai/src/config.ts`
- locale 文件

工作：

- 卡片聚合多目标摘要；
- 设置页 Windows-only WSL section：
  - WSL availability；
  - 每个 distro 的 state/version/default；
  - 扫描启用开关；
  - `not-scanned/failed` 诊断和“扫描此环境”；
- 默认排除基础设施发行版，允许用户显式启用；
- Linux/macOS 不渲染任何 WSL 控件；
- 监听等级按 detection capability 显示，不再只看 registry tier。

验收：

- 一张 CLI 卡不会因三份安装复制三次；
- unknown 不显示成 missing；
- WSL 不可用、无发行版、部分失败三个空态不同；
- 现有分页容量不因副标题增加发生回退；
- zh-CN/en 文案完整。

建议提交：`feat(ai): expose WSL runtime selection`

### WP7：WSL full monitoring 闸门

这部分在 WP0–WP6 稳定后独立实施，不能与基础启动混为一个大提交。

第一阶段仅覆盖从 Dashboard/profile 直接启动的 Claude Code 和 OpenCode：

- 监听 adapter 不再直接假设 host path/env/args，而通过 runtime seam 注入 CLI 内层
  args、env 和临时资源；
- Claude：
  - settings 文件必须转换成目标发行版可读路径；
  - callback 必须通过 capability probe 证明 WSL 能到达；
  - 不能为了可达性把无 token 的 ingress 暴露到局域网；
- OpenCode：
  - port 必须同时考虑 Windows 和 WSL 命名空间；
  - Windows renderer 到 WSL server 的 localhost forwarding 必须实测；
  - 不可达或端口冲突时保持 TUI 可用并降级为 launch-only；
- 所有降级都写入 detection/session capability，UI 不伪造 working/thinking。

普通 WSL terminal 中手动启动 CLI 暂缓：

- Windows process tree 看不到 Linux CLI 子进程；
- 当前 Windows temp PATH shim 无法进入 WSL shell；
- 需要单独设计发行版内的短命 shim/进程发现与安全清理。

它应另立计划，不应作为 WP7 的顺手扩展。

验收：

- Dashboard 直接启动的 WSL Claude/OpenCode 真实事件回合；
- permission/question、thinking/working/idle/error；
- WSL 1/2、NAT/mirrored networking 或明确 capability fallback；
- 关闭 tab 后临时文件、端口和 token 清理；
- native full monitoring 全回归。

建议提交：按 Claude/OpenCode 分两个提交，不合并成一个。

### WP8：全量验证与文档回写

- `yarn test`
- `yarn eslint --ext ts tabby-ai/src tabby-electron/src/shells tabby-local/src`
- `yarn build`
- Windows native、Ubuntu-22.04、无 WSL fixture 的人工矩阵；
- Linux/macOS CI 确认没有执行 `wsl.exe`；
- 把实际完成项、偏差和已知限制回写本计划。

## 4. 实施顺序与合并闸门

```text
WP0 模型
  ↓
WP1 发行版枚举
  ↓
WP2 运行时 seam
  ↓
WP3 扫描
  ↓
WP4 启动 ──→ 可独立发布“WSL 扫描 + 启动”
  ↓
WP5 安装
  ↓
WP6 UI/设置 ─→ 完成首版 WSL 运行目标支持
  ↓
WP7 直接启动的 full monitoring
  ↓
WP8 全量收尾
```

每个 WP 单独提交并通过本工作包测试后再进入下一步。尤其 WP7 不阻塞 WP0–WP6，
但在 WP7 通过前，WSL detection 的 `monitoring` 必须是 `launch`。

## 5. 首版完成定义

1. Windows 原生扫描、启动、安装和监听无退化。
2. Linux/macOS 只走 native 路径，不 spawn 或显示 WSL。
3. Windows 能列出多个用户启用的 WSL 发行版，并区分 default/running/stopped/version。
4. 同一 CLI 的 native/WSL 路径与版本分别保存，一张卡聚合展示。
5. WSL inherited Windows PATH 命中不会被算作 WSL-local 安装。
6. 启动 modal 可以选择目标，cwd 与参数正确进入指定发行版。
7. 安装 modal 使用目标平台 recipe，并只以同目标重扫结果判成功。
8. stopped 发行版未扫描时显示 unknown；explicit rescan 可以唤醒扫描，且不 terminate。
9. 单个发行版失败或超时不会清空其他扫描结果。
10. WSL full monitoring 未验证前诚实显示 launch-only；WP7 通过后才升级对应 capability。

## 6. 主要风险

### WSL 管理输出不是稳定机器协议

官方没有 JSON。必须以 quiet 名称集合为主，verbose 只补信息；所有解析集中在一个
兼容层并以 fixtures 锁定。

### 自动扫描会启动 stopped 发行版

这是官方行为。startup 只额外唤醒默认发行版，explicit rescan 才扫描全部启用目标；
绝不自动 terminate。

### Windows PATH 污染造成重复或错误命中

只看 `command -v` 一定会错。realpath + `wslpath -w` 归属校验是合并闸门。

### cwd 跨文件系统

不能硬编码 `/mnt/c`，也不能让 Windows `existsSync` 校验 Linux 路径。统一交给
runtime seam 和 `wsl.exe --cd`。

### 监听能力跨越文件与网络命名空间

启动成功不代表监听成功。capability 必须属于“CLI 安装 + target”组合，并允许
安全降级；registry tier 只表达“存在 adapter”，不表达“所有运行目标均可监听”。
