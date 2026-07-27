# WSL 运行目标：官方接口调研

> 调研日期：2026-07-27
> 范围：只确认 Windows / WSL 的官方接口、行为边界和实现风险，不实施功能。
> 资料约束：Microsoft Learn 与微软开源的 WSL 实现；源码结论固定到
> `microsoft/WSL@c268673b4a2af113fce712a2a14b0c8a705f348a`。

## 1. 结论

1. WSL 支持必须只在 Windows 主机启用。Linux 和 macOS 只扫描本机，不执行
   `wsl.exe`，也不显示 WSL 运行目标。
2. 一个 WSL 发行版就是一个独立运行目标；同名 CLI 在 Windows、Ubuntu、Debian
   中的路径和版本必须分别保存。
3. `wsl.exe --list --verbose` 是微软文档指定的“名称 + 状态 + WSL 1/2”查询面，
   但没有 JSON 等稳定机器格式。自动化应结合 `--quiet`、`--running --quiet`，
   并把 verbose 表格解析封装在单一兼容层。
4. 指定发行版并省略 `--user` 会使用该发行版的默认用户。`--exec` 不经过 shell，
   适合执行已知绝对路径；发现 CLI 时则需要考虑用户登录 shell 对 `PATH` 的修改。
5. 在停止的发行版里执行任何探测命令都会启动它。管理层枚举不会启动发行版，
   但 CLI 探测不是纯只读的“状态观察”。
6. `--cd` 原生接受 Linux 路径和绝对 Windows 路径；不要把 `C:\x` 手写成
   `/mnt/c/x`，因为发行版可以修改或关闭 Windows 驱动器自动挂载。
7. `wsl.exe` 自身的管理输出默认可能是 UTF-16；设置进程环境
   `WSL_UTF8=1` 可切换为 UTF-8。错误文本会本地化，不能靠英文字符串判错。
8. `wsl.exe` 没有供 CLI 调用者使用的超时参数。扫描器必须设置自己的短超时、
   输出上限和取消逻辑。

## 2. 平台边界

WSL 是 Windows 的子系统，公开的 `wslapi.h` 也明确将目标平台标为 Windows。
因此运行目标矩阵应是：

| Vibby 主机 | 扫描目标 |
| --- | --- |
| Windows | Windows native + 已注册的 WSL 发行版 |
| Linux | Linux native |
| macOS | macOS native |

WSL 1 和 WSL 2 是发行版属性，不是另一层 UI 分组。微软明确支持一台机器安装和运行
多个发行版。

来源：

- [Microsoft Learn：What is WSL](https://learn.microsoft.com/en-us/windows/wsl/about)
- [Microsoft Learn：Install WSL / Ways to run multiple distributions](https://learn.microsoft.com/en-us/windows/wsl/install#ways-to-run-multiple-linux-distributions-with-wsl)
- [Microsoft Learn：wslapi.h](https://learn.microsoft.com/en-us/windows/win32/api/wslapi/)

## 3. 枚举发行版、默认项、状态和 WSL 版本

### 3.1 官方 CLI 能力

微软文档定义：

- `wsl.exe --list --verbose`：列出已安装发行版、运行/停止状态和 WSL 1/2。
- `wsl.exe --list --quiet`：只输出发行版名称。
- `wsl.exe --list --running`：只列出正在运行的发行版。
- `wsl.exe --list --all`：包含安装、卸载等过渡状态的发行版。
- `wsl.exe --status`：显示默认发行版类型、默认发行版和内核等总体配置。

来源：

- [Microsoft Learn：Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#list-installed-linux-distributions)

没有官方的 `--json` 输出。当前微软源码中，verbose 行的结构是：

```text
<default marker> <name> <state> <version>
```

默认发行版使用 `*` 标记；状态实现当前包含 `Running`、`Stopped`、
`Installing`、`Uninstalling`、`Converting` 和 `Exporting`。源码先将默认发行版
排到列表首位，再打印表格。`--quiet` 则每行只打印一个名称。

来源：

- [WSL 源码：ListDistributionsHelper](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/WslClient.cpp#L707-L813)

这些表格细节是当前官方实现，不是文档承诺的序列化协议。推荐将其限制在一个
`WslDistributionEnumerator` 内，避免 UI 和业务服务重复解析。

### 3.2 推荐的兼容读取策略

在同一轮枚举中，以 `WSL_UTF8=1` 启动三个短命令：

```text
wsl.exe --list --quiet
wsl.exe --list --running --quiet
wsl.exe --list --verbose
```

用途分别为：

1. 第一条得到不依赖列宽和状态语言的发行版名称集合。
2. 第二条得到正在运行的名称集合，不需要解析 `Running` 文本。
3. 第三条只负责补充默认标记和 WSL 1/2；从行尾读取数字版本，从行首读取 `*`。

三个结果必须按发行版名称合并，不能假定它们的行号永远一致。verbose 解析失败时，
仍可保留名称和运行状态，将 `version/default` 标为未知，而不是让整个 WSL 扫描
失败。

如果未来愿意增加一个 Windows native helper，公开的
`WslGetDistributionConfiguration` 可按已知名称读取 WSL 版本、默认 UID 和配置
flags；但该 API 不负责枚举名称、查询运行状态或指出默认发行版，所以不能单独替代
上述 CLI。

来源：

- [Microsoft Learn：WslGetDistributionConfiguration](https://learn.microsoft.com/en-us/windows/win32/api/wslapi/nf-wslapi-wslgetdistributionconfiguration)

## 4. 在指定发行版中执行命令

### 4.1 默认用户和无 shell 执行

推荐始终把发行版名称作为独立 argv 传给 `wsl.exe`，不要拼接 shell 字符串：

```text
wsl.exe --distribution <DistroName> --exec <Program> <Arg...>
```

- `--distribution` 选择目标发行版。
- 省略 `--user` 时使用发行版默认用户。
- `--exec` 将程序和参数直接交给 Linux `exec`，不经过默认 shell。
- 显式 `--user <name>` 才覆盖默认用户；用户不存在时会报错。

默认用户可由每个发行版的 `/etc/wsl.conf` 中 `[user] default=...` 配置，因此不能
假定它等于 Windows 用户名，也不能为了扫描固定使用 `root`。

来源：

- [Microsoft Learn：Run a specific distribution / user](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#run-a-specific-linux-distribution-from-powershell-or-cmd)
- [Microsoft Learn：Advanced settings / user.default](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#user-settings)
- [WSL 源码：shell、exec 和默认用户三种启动路径](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/service/exe/LxssUserSession.cpp#L794-L840)
- [WSL release notes：`--exec` 不使用默认 shell](https://learn.microsoft.com/en-us/windows/wsl/release-notes#build-18305)

### 4.2 CLI 发现为何不能只用 `--exec command -v`

`command` 通常是 shell builtin，不是可直接 `exec` 的文件；更重要的是，用户可能在
shell profile 中追加 npm、Homebrew/Linuxbrew、mise、asdf、nvm 等路径。直接执行
`/usr/bin/which` 或 `env` 只能看到 WSL 的基础环境，不一定等于用户打开终端后看到
的 `PATH`。

当前 WSL 实现支持：

```text
--shell-type standard
--shell-type login
--shell-type none
```

有命令且未指定 shell type 时，WSL 经默认用户的默认 shell 执行命令，但不是 login
shell；`--exec` / `--shell-type none` 完全绕过 shell；`--shell-type login` 则要求
默认 shell 按登录模式运行。

来源：

- [WSL 源码：ShellExecOptions](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/WslClient.cpp#L64-L108)
- [WSL 源码：命令通过 shell 或直接 exec 的分支](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/WslClient.cpp#L1787-L1825)

推荐探测策略是：

1. 新版 WSL 优先在目标发行版的默认用户 login shell 中运行一段固定探测脚本。
2. 旧版不支持 `--shell-type` 时，降级到 `--exec /bin/sh -lc <probe>`，并把结果
   标为兼容模式；它不保证等于用户的 zsh/fish 等默认 shell 环境。
3. 探测脚本只允许来自 Vibby registry 的固定 binary 名称，使用严格引用和机器
   可识别的记录分隔，不能插入用户输入。
4. 发现命令后，在同一 shell 环境执行其 `--version`；不要先取得一个路径，再在
   不同环境里执行。

### 4.3 login shell 仍不是绝对可靠

微软只保证 WSL 会请求默认 shell 的 login 模式，并未保证任意 shell/profile 一定
产生干净、快速、非交互的输出。实际风险包括：

- 不同 shell 读取的 profile 文件不同；
- 用户可能只在 interactive rc 中修改 `PATH`；
- profile 可能打印 banner、输出 ANSI 控制序列、等待网络甚至报错；
- `command -v` 可能解析到 shell function、alias 或 shim，而不是真实文件；
- WSL 默认把 Windows `%PATH%` 追加进 Linux `$PATH`，所以 `command -v codex`
  可能命中 `/mnt/c/...` 中的 Windows Codex，而不是该发行版自己的安装；
- `/etc/profile` 或用户 profile 可以覆盖 WSL 注入的标准 `PATH`。

微软故障排查文档也明确记录了 `/etc/profile` 重写 `PATH`、
`appendWindowsPath=false` 等配置会改变 WSL 会话中的路径。

因此探测协议必须允许额外噪声、设置超时，并以“同一环境中实际执行
`<cli> --version` 成功”为可用性判定，不能只相信 `command -v` 的一行文本。
此外必须校验 executable 的文件系统归属：

1. 将命中项解析为真实文件路径；function/alias 只能标为 shell-only 命中，不能
   当作可供 direct launch 的 executable。
2. 在同一目标发行版执行 `wslpath -w <resolved-path>`。
3. 结果是 `C:\...` 等 Windows 路径时，说明它来自 Windows-mounted filesystem，
   应归到 Windows native 安装或标记为 inherited，不得重复计作该 WSL 发行版安装。
4. 结果是 `\\wsl.localhost\<Distro>\...`（旧别名可能是 `\\wsl$`）时，才是目标
   发行版的 Linux 文件系统。

来源：

- [Microsoft Learn：Troubleshooting / PATH can be overwritten](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting#running-windows-commands-fails-inside-a-distribution)
- [Microsoft Learn：wsl.conf interop settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#interop-settings)
- [Microsoft Learn：WSL files via `\\wsl$`](https://learn.microsoft.com/en-us/windows/wsl/filesystems#view-your-current-directory-in-windows-file-explorer)

本机验证（2026-07-27，非接口保证）：Ubuntu-22.04 的 `$PATH` 中包含大量
`/mnt/c/...`，Claude/Codex/Gemini/Pi 均可被 `command -v` 从 Windows 安装误命中；
`wslpath -w /home/...` 返回 `\\wsl.localhost\Ubuntu-22.04\...`，而
`wslpath -w /mnt/c/...` 返回 `C:\...`。这验证了上述归属校验必须进入验收测试。

## 5. `--cd`、路径转换与 cwd

### 5.1 `--cd` 的确切分类

当前官方实现接受两类 `--cd` 参数：

1. 以 `/` 或 `~` 开头：作为 Linux 路径直接传入目标发行版。
2. 其他路径：必须是绝对 Windows 路径；`wsl.exe` 先切换 Windows cwd，再由 WSL
   启动层翻译。

来源：

- [WSL 源码：ChangeDirectory](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/WslClient.cpp#L199-L217)

不传 `--cd` 时，当前实现读取 `wsl.exe` 进程的 Windows cwd 并交给 WSL 翻译。
微软安装文档也用“在 PowerShell 当前目录执行 `wsl pwd`”演示该映射。只有读取或
翻译 cwd 失败时，才可能退回默认用户 home；不能把“总是从 home 启动”当作默认
语义。

来源：

- [WSL 源码：继承 Windows current directory](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/svccomm.cpp#L39-L56)
- [WSL 源码：空 cwd 使用用户 home](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/service/exe/LxssCreateProcess.cpp#L94-L102)
- [Microsoft Learn：`wsl pwd` maps the current Windows directory](https://learn.microsoft.com/en-us/windows/wsl/install#ways-to-run-multiple-linux-distributions-with-wsl)

### 5.2 不要手写 `/mnt/c`

发行版可通过 `/etc/wsl.conf` 修改 automount root，也可以完全关闭 Windows drive
automount；所以 `C:\work` 并不永远等于 `/mnt/c/work`。

选择顺序应为：

1. 已知 Linux 路径：直接 `--cd /home/...` 或 `--cd ~`。
2. Windows 本地绝对路径：原样交给 `--cd C:\...`，由 WSL 按该发行版配置转换。
3. 必须预先得到 Linux 字符串时：在目标发行版运行 `wslpath -a -u <WindowsPath>`。
4. `\\wsl.localhost\<Distro>\...` / `\\wsl$\<Distro>\...`：先校验 UNC 中的发行版
   与目标一致，再取其 Linux 内部路径；不要把一个发行版的 Linux 路径交给另一个
   发行版。

第 4 点是基于 WSL 文件系统隔离做出的集成约束，不是 `wsl.exe` 的跨发行版转换
保证。

来源：

- [Microsoft Learn：Working across Windows and Linux file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
- [Microsoft Learn：wsl.conf automount settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#automount-settings)
- [Microsoft Learn：WSL interop / path translation](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop#path-translation)
- [WSL release notes：`wslpath` 的 `-a/-u/-w/-m`](https://learn.microsoft.com/en-us/windows/wsl/release-notes#build-17046)

## 6. 停止的发行版会被探测命令启动

会。微软网络文档明确说明，主机侧 `wsl.exe --distribution <Distro> <command>`
会启动目标 instance 后执行 Linux 命令；当前开源实现也在每次创建 Linux process
之前调用 `_CreateInstance`。

来源：

- [Microsoft Learn：host `wsl.exe` launches the target instance](https://learn.microsoft.com/en-us/windows/wsl/networking#identify-ip-address)
- [WSL 源码：CreateLxProcess creates an instance](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/service/exe/LxssUserSession.cpp#L803-L840)

产品含义：

- `--list` 类管理命令可以安全枚举而不唤醒每个发行版。
- `command -v`、`which`、`--version` 等 CLI 探测会唤醒目标发行版。
- 不应在探测后调用 `wsl --terminate`“恢复原状态”，因为那可能终止用户原有服务
  或并发任务。
- 第一版需要明确选择：启动时扫描所有 stopped 发行版，或只自动扫描 running
  发行版、在用户选择/手动重扫时再唤醒 stopped 发行版。UI 不能把“尚未扫描”
  错写成“未安装”。

## 7. 退出码、超时、编码和本地化

### 7.1 退出码

正常 Linux 进程退出时，`wsl.exe` 等待该进程并返回其 exit status。WSL 自身的
通用失败使用 `-1`，源码说明这是为了与 Linux 进程失败区分；Windows 调用方通常
会看到无符号的 `0xFFFFFFFF`。错误原因通过 stderr 的本地化文本补充。

来源：

- [WSL 源码：等待并返回 Linux exit status](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/svccomm.cpp#L402-L416)
- [WSL 源码：WSL internal failure uses `-1`](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/WslClient.cpp#L1538-L1541)
- [WSL 源码：exception mapping and localized error print](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/WslClient.cpp#L1907-L1956)

扫描器应把结果至少分为：

- `0`：探测成功；
- Linux 非零退出：CLI 不存在、版本命令失败或探测脚本失败；
- WSL internal failure / spawn failure：运行目标不可用；
- timeout / cancelled：状态未知，不等同于“未安装”。

### 7.2 超时和取消

WSL 内部 process wait 的默认值是 `INFINITE`；公开 CLI 没有相应 timeout flag。
Vibby 必须在宿主层设置：

- 枚举命令的短超时；
- 每个发行版探测的独立超时；
- stdout/stderr 最大字节数；
- 应用关闭和重新扫描时的取消信号。

终止 `wsl.exe` wrapper 后，不应进一步调用 `wsl --terminate <Distro>`，后者是
终止整个发行版，不是只取消本次 probe。

来源：

- [WSL 源码：LaunchProcess timeout defaults to `INFINITE`](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/svccomm.hpp#L58-L67)
- [Microsoft Learn：`wsl --terminate` terminates a distribution](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#terminate)

### 7.3 编码和本地化

当前 `wsl.exe` 源码默认把自身 CRT 输出设为 UTF-16；只有进程环境
`WSL_UTF8=1` 时才改成 UTF-8。这影响 `--list`、`--status`、`--help` 和 WSL 错误
文本等管理输出。

来源：

- [WSL 源码：`WSL_UTF8` output switch](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/WslClient.cpp#L1843-L1856)

实现要求：

- 所有管理命令显式设置 `WSL_UTF8=1`，不要依赖 Windows console code page。
- 为忽略该环境变量的旧 inbox WSL 保留 UTF-16LE fallback：有 BOM 或输出中出现
  大量交替 NUL 时，按 UTF-16LE 重新解码。
- Linux 子进程 stdout/stderr 是另一条数据通道；按字节收集，以 UTF-8 宽容解码，
  并允许 CLI 自己输出非 UTF-8 或 ANSI 序列。
- 不解析本地化的 header、帮助或错误句子来分类状态。
- 解析记录应使用 ASCII marker/分隔符；保留原 stderr 仅供 UI 诊断。

本机验证（2026-07-27，非接口保证）：未设置 `WSL_UTF8=1` 时，当前 Windows/Node
管线中的 `wsl.exe --list --verbose` 确实产生 UTF-16LE；直接按 UTF-8 解码会出现
交替 NUL 和乱码。

## 8. WSL 未安装、未启用或没有发行版

微软最新 interop 指南要求调用方先确认系统目录中的 `wsl.exe` 存在，再执行
`wsl.exe --status` 并检查退出码；它同时指出，WSL interop 需要 WSL 已安装且至少
注册一个 Linux 发行版。

来源：

- [Microsoft Learn：Detect whether WSL is available](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop#detect-whether-wsl-is-available)

`wsl.exe` 文件存在不代表 WSL 已可运行。微软历史 release notes 明确记录：
Windows 会在可选组件未安装时仍提供 `wsl.exe` 以便功能发现，并可能只打印帮助。
当前 Store WSL 源码在接口/可选组件不可用时会抛出
`WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED` 或 OS-not-supported 错误，最终仍以本地化
文本和非零退出呈现。

来源：

- [WSL release notes：stub remains and prints help when component is absent](https://learn.microsoft.com/en-us/windows/wsl/release-notes#build-19555)
- [WSL 源码：optional-component capability check](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/svccomm.cpp#L151-L173)

没有发行版时，当前实现的 `--list --quiet` 会成功但输出空集合；非 quiet 或 verbose
路径会抛出 `WSL_E_DEFAULT_DISTRO_NOT_FOUND`。因此不要使用 verbose 成败作为
“WSL 是否安装”的唯一探针。

来源：

- [WSL 源码：quiet empty list vs default-distro error](https://github.com/microsoft/WSL/blob/c268673b4a2af113fce712a2a14b0c8a705f348a/src/windows/common/WslClient.cpp#L722-L813)

推荐分类流程：

1. 非 Windows：不进入 WSL 流程。
2. 系统目录不存在 `wsl.exe`，或创建进程失败：`unavailable`。
3. 以短超时运行 `wsl.exe --status`；非零只说明 unavailable/no-distro 等候选，
   不解析本地化文字做最终分类。
4. `WSL_UTF8=1 wsl.exe --list --quiet` 成功且无名称：`available-no-distro`。
5. list 命令非零、超时或输出异常：`unavailable-or-misconfigured`，保存 stderr
   诊断，但不匹配其语言。
6. 得到名称：`available`；后续单个发行版失败只能影响该运行目标。

这个分类刻意不猜测“缺 Store package”“可选组件关闭”“需要重启”“服务故障”等
具体原因，因为微软没有为 `wsl.exe` CLI 文档化稳定的机器错误协议。

## 9. 建议的数据与扫描边界

建议运行目标最小模型：

```ts
type CliRuntimeTarget =
    | {
        type: 'native'
        platform: 'windows' | 'linux' | 'macos'
    }
    | {
        type: 'wsl'
        distro: string
        wslVersion: 1 | 2 | null
        isDefault: boolean
        state: 'running' | 'stopped' | 'unknown'
    }
```

每个 CLI 对应零到多个检测结果：

```ts
interface CliInstallation {
    cliKind: string
    target: CliRuntimeTarget
    executable: string | null
    version: string | null
    scanState: 'detected' | 'missing' | 'not-scanned' | 'failed'
}
```

必须保留 `not-scanned`，因为 stopped 发行版若未被主动唤醒，并不能断言 CLI
不存在。

推荐服务边界：

1. `WslDistributionEnumerator`：只处理 `wsl.exe` 管理命令、UTF 编码、表格兼容和
   WSL availability。
2. `WslCommandRunner`：只处理目标发行版、默认用户、cwd、timeout、取消和输出上限。
3. 现有 CLI registry / scanner：提供固定 binary 与 version probe，不直接知道
   `wsl.exe` 参数。
4. UI：消费聚合后的 installations；同一个 CLI 仍是一张卡，在启动/安装 modal
   选择 Windows 或具体 WSL 发行版。

## 10. 实施前验证矩阵

至少覆盖：

- Windows 未启用 WSL、只有 stub、WSL 可用但无发行版。
- 一个发行版与多个发行版；默认发行版不是列表中唯一 running 项。
- WSL 1、WSL 2、Stopped、Running，以及过渡状态不参与 CLI probe。
- 发行版名称含空格/Unicode；Windows 显示语言不是英文。
- 列表包含不适合作为普通用户终端的系统型发行版时，单项 capability probe 失败
  只将该目标标为 unsupported，不能拖垮整个扫描。
- 默认用户为非 root，自定义默认 shell，自定义/被覆盖的 `PATH`。
- CLI 位于系统 PATH、npm user prefix、nvm/mise/asdf 路径。
- Windows PATH 被 WSL 继承时，Windows-mounted CLI 不得重复算作 WSL-local 安装。
- login profile 输出 banner、退出非零、阻塞和产生大量输出。
- Windows cwd、Linux cwd、带空格路径、自定义 automount root、
  `\\wsl.localhost\<same-distro>\...`。
- probe 超时、应用取消、单个发行版启动失败不拖垮其他目标。
- 验证 stopped 发行版被 probe 唤醒后，Vibby 不主动 terminate 它。
