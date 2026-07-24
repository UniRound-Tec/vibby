# vibby 品牌化二开：触点地图与改动策略

> 调研日期：2026-07-24 ｜ 基线：upstream/master @ `14e2d60b`（v1.0.235）
> fork：github.com/UniRound-Tec/vibby ｜ 上游：github.com/Eugeny/tabby

## 0. 结论速览

- **保留 `tabby-` 代码前缀，只改用户可见层。** 前缀是承重结构：插件加载器（`app/src/plugins.ts:96` 的 `PLUGIN_PREFIX`）、插件市场搜索、构建脚本、全部跨包 import 都依赖它。改前缀 = 重命名 12 个工作区目录 + 数百处 import，且此后每次合并上游都是灾难。用户看到的是 productName，不是 npm 包名。
- **最高优先级是遥测与更新源**：Sentry DSN 和 Mixpanel token 硬编码为原作者账户，不换掉则我方用户的崩溃/分析数据发往原作者；更新源不改则用户会被自动"更新"回官方 Tabby。
- **品牌改动集中成独立 commit（或按类别少数几个）**，每次 `git merge upstream/master` 时冲突点语义清晰、机械可解。
- 上游遗留的 `terminus-*` 兼容别名是迁移逻辑，**保留不动**。

## 1. 品牌触点完整地图

### 1.1 应用身份（改动集中、冲突风险最低，最先做）

| 位置 | 内容 |
|---|---|
| `electron-builder.yml:2-3` | `appId: org.tabby`、`productName: Tabby` |
| `electron-builder.yml:6-9` | 自定义协议 `tabby://` |
| `electron-builder.yml:46,51,58,78` | 四平台安装包命名 `tabby-${version}-...` |
| `electron-builder.yml:54` | Windows 快捷方式名 `Tabby Terminal` |
| `electron-builder.yml:83-84` | Linux `StartupWMClass: tabby`、`MimeType: x-scheme-handler/tabby` |
| `app/package.json:2,5,7` | 包名 `tabby`、repository、author |
| `app/lib/index.ts:38-45` | `setAsDefaultProtocolClient('tabby')` 协议注册 |
| `app/lib/urlHandler.ts:4-8,23,59` | `tabby://` URL 解析（另见 `app/lib/window.ts:14,283-285`） |
| `snap/snapcraft.yaml:1,5,11-12,24-25` | snap 包名与路径 |

⚠️ **productName 决定配置目录名**（`app.getPath('userData')`，见 `app/lib/index.ts:12`、`app/lib/config.ts:7`）。首发前定好名字，之后不要再改，否则老用户配置"丢失"（上游为 terminus→tabby 改名留过回退逻辑，`config.ts:8`）。

环境变量前缀 `TABBY_DEV` / `TABBY_PLUGINS` / `TABBY_CONFIG_DIRECTORY`（`app/lib/index.ts:11-12`、`app/lib/app.ts:385`、`sentry.ts:11`、`updater.service.ts:48`、根 `package.json` scripts）属开发者接口，可保留不改。

### 1.2 遥测（法务/隐私优先级最高）

| 位置 | 内容 |
|---|---|
| `app/lib/sentry.ts:1-19` | 硬编码 Sentry DSN（原作者账户），preload 注入见 `app/lib/window.ts:69` |
| `tabby-core/src/services/homeBase.service.ts:47-57` | Mixpanel token 硬编码，跟踪 freshInstall/launch |
| 开关 UI | `welcomeTab.component.pug:63-65`、`settingsTab.component.pug:84-87` |

处理方式：换成自有 DSN/token，或直接摘除。相关构建配套：`scripts/sentry-upload.mjs`、`.github/workflows/build.yml`、根 `package.json` 的 `@sentry/cli`、`@sentry/electron`。

### 1.3 自动更新

| 位置 | 内容 |
|---|---|
| `tabby-electron/src/services/updater.service.ts:6,103,108,119,124` | 硬编码 `api.github.com/repos/eugeny/tabby/releases/latest` |
| `app/lib/window.ts:2,491-518` | electron-updater，发布源跟随 electron-builder publish 配置 |
| `tabby-settings/src/components/releaseNotesTab.component.ts:32` | Release notes 拉取 eugeny/tabby releases |

### 1.4 UI 可见字符串（约 40 处，分散但均为单行改动）

主进程：

- 窗口标题 `app/lib/window.ts:64`
- 托盘提示 `app/lib/app.ts:213`、macOS 菜单 About/`app/lib/app.ts:312`、官网链接 `:376-378`
- 启动失败弹窗 `app/lib/index.ts:113`
- 启动画面 `app/index.pug:2,19-20`（`.tabby-logo`/`.tabby-title`）

渲染层（pug 模板，字符串同时是 ngx-translate 的翻译 key，改英文原文后需同步 `locale/`，否则各语言回退英文）：

- 欢迎页 `tabby-core/src/components/welcomeTab.component.pug:3-7,64,71`
- 标题栏 `titleBar.component.pug:1`、起始页 `startPage.component.pug:4`、安全模式弹窗 `safeModeModal.component.pug`
- 设置 About 区块 `tabby-settings/src/components/settingsTab.component.pug:12-16,67,85`
- 其余含 "Tabby" 的设置页：`configSyncSettingsTab`(3)、`profilesSettingsTab`、`vaultSettingsTab`、`windowSettingsTab`、`terminalSettingsTab` 各 1 处

Windows 右键菜单集成（注册表键含品牌名）：`tabby-electron/src/services/shellIntegration.service.ts:16,19-35,77-81`（`shell\Tabby` 键、"Open Tabby here"，macOS Automator workflow 同文件）。

各目录 `Tabby` 字面量计数（.ts/.pug/.html/.scss）：`app/` 14、`tabby-core/` 13、`tabby-settings/` 12、`tabby-electron/` 14（其中 11 处在 shellIntegration）、`tabby-terminal/` 5（多为配色方案名，非品牌）。`TabbyFormatedDatePipe`（`tabby-core/src/index.ts:47,135,150`）是类名，非用户可见，不改。

### 1.5 视觉资产

| 用途 | 文件 |
|---|---|
| 安装包/桌面图标 | `build/windows/icon.ico`、`build/mac/icon.icns`、`build/icons/{16,32,64,128,256,512}.png` + `icon.svg` + `Icon-MacOS-512x512@2x.png` |
| 应用内 logo | `app/assets/logo.svg`（启动画面/欢迎页，CSS 见 `app/src/preload.scss:46-56`、`welcomeTab.component.scss:10`、settingsTab 同名样式） |
| 托盘 | `app/assets/tray.png`、`tray-darwinTemplate.png(@2x)`、`tray-darwinHighlightTemplate.png(@2x)`（macOS Template 需纯黑+透明单色剪影）、任务栏活动指示 `activity.png`（`app/lib/window.ts:32`） |

素材需求：彩色主 logo SVG 母版（或 ≥1024px 透明底 PNG）+ 单色剪影版；应用内为深色背景，注意适配。

### 1.6 外链（tabby.sh / github.com/Eugeny）

- `tabby-core/src/services/homeBase.service.ts:27,31,35,44` — GitHub、Discord、翻译平台、issues
- `tabby-core/src/services/config.service.ts:437` — **配置同步默认 `https://api.tabby.sh`**：要么自建 tabby-web 服务替换，要么隐藏配置同步功能
- `tabby-settings/src/components/configSyncSettingsTab.component.ts:138-139,146` — `api.tabby.sh`/`app.tabby.sh`/tabby-web 仓库
- `tabby-ssh/src/components/sftpPanel.component.pug:58`、`sshTab.component.pug:18` — 帮助链接 `tabby.sh/go/cwd-detection`
- `app/lib/app.ts:378` — 官网菜单项
- 仅注释、无功能影响：`tabby-linkifier/src/handlers.ts:14`、`tabby-terminal/src/api/baseTerminalTab.component.ts:353`

### 1.7 插件系统（理解用，大部分不改）

- 加载器：`app/src/plugins.ts:96-97`（`tabby-`/`terminus-` 前缀）、`:45-48`（内置插件列表）、`:165,178`（`tabby-plugin` keyword 识别）、`:245-246`（新旧名映射）
- 插件市场：`tabby-plugin-manager/src/services/pluginManager.service.ts:29-30,53,56`（按 keyword 搜 npm registry）——若不想让用户装社区 Tabby 插件，改这里的 keyword
- 强制启用的内置插件：`pluginsSettingsTab.component.ts:12`
- 黑名单：`app/src/pluginBlacklist.ts`
- 用户插件目录：`app/lib/app.ts:83-89`
- 构建侧内置插件清单：`scripts/vars.mjs:22-47`、`scripts/prepackage-plugins.mjs:18`
- `@tabby-gang/*` 是外部 npm 原生模块包（`app/lib/window.ts:18`、`tabby-electron/src/pty.ts:13`、`platform.service.ts:20`），fork 无需改名

### 1.8 CI / 发布

- `.github/workflows/build.yml:239,258,297` — 制品名 `tabby-web.tar.gz`、发布目标仓库 `eugeny/tabby`（需改为本 fork）
- `.github/workflows/docs.yml:37,39` — `tabby-docs` Firebase 项目（不用可删）
- `electron-builder.yml:100,112` — `--replaces terminus-terminal`（deb/rpm 迁移逻辑，fork 可删可留）
- 仓库内无 choco/winget 配置

## 2. 本地开发环境记录

- **工具链**：Node 22（CI 指定，本地 24 实测可用）+ yarn 1.x（classic）
- **构建流程**：`yarn` → `yarn build:typings` → `yarn build` → `yarn start`（均已验证通过，2026-07-24）
- **Windows 前置要求：VS2022 "Spectre 缓解库"组件**（VS Installer →「单个组件」→ *MSVC v143 - VC++ 2022 Spectre 缓解库*，本机已于 2026-07-24 安装）。缺少它时 node-pty 和 @tabby-gang/windows-process-tree 编译报 MSB8040，且会引发连锁故障（见下条）。CI 的 Windows 镜像自带该组件。临时绕过方案（不推荐，仅备查）：用 patch-package 删掉这两个包 `binding.gyp` 里的 `SpectreMitigation` 配置
- **Windows 踩坑（卡启动画面）**：windows-process-tree 是 optionalDependency，编译失败会被 yarn **静默删除**。缺了它会导致应用卡在启动 Logo：`tabby-electron/src/services/platform.service.ts` 把它和 `windows-native-registry` 的 require 放在同一个 try/catch 里，第一个抛错导致第二个未执行、`wnr` 为 undefined，启动时 `getWinSCPPath()` 抛 `Cannot read properties of undefined (reading 'getRegistryKey')`，Angular 引导失败（连安全模式也失败）。恢复方法：装好 Spectre 组件后 `cd app && yarn install --ignore-scripts && yarn postinstall`，回根目录 `node scripts/build-native.mjs`
- **调试渲染进程**：`ELECTRON_ENABLE_LOGGING=1 yarn start` 可把渲染进程 console 输出到终端；注意 `yarn watch` 只覆盖各插件包，改 `app/src`（如 entry.ts）需手动 `node_modules/.bin/webpack -c app/webpack.config.mjs`
- **⚠️ dev 实例默认与已安装的正式版 Tabby 共用数据目录**：dev 应用名 `tabby` 与正式版 `Tabby` 在 Windows 下解析为同一个 `%APPDATA%\Tabby`——config.yaml、localStorage（含标签恢复状态 `tabsRecovery`）、log.txt 全部共享。后果：① dev 启动会"恢复"正式版上次会话的标签，恢复令牌里的 `restoreFromPTYID` 指向另一个进程的 PTY，重连失败时可能得到一个没有会话的空终端；② 两个实例并发写 config.yaml 有损坏真实配置的风险。**隔离方法（本仓已启用）**：创建 `node_modules/electron/dist/data` 目录，`app/lib/portable.ts` 检测到 exe 旁的 `data` 目录会把整个 userData 切过去（便携模式机制）。注意重装 node_modules 后该目录会消失，需重建。这也是品牌化后 productName 改名会自然带来的隔离——正式发布不受影响
- fork 后必须拉上游 tags（`git fetch upstream --tags`），版本号由 `git describe` 生成

## 3. 上游同步机制

- `upstream` remote → `github.com/Eugeny/tabby`（已配置），主分支为 `master`
- 常规同步：`git fetch upstream --tags && git merge upstream/master`
- 降冲突纪律：品牌改动集中成独立 commit；不要顺手重构上游代码；`tabby-` 前缀与 `terminus-*` 兼容逻辑不动
- 备选方案（暂不采用）：`scripts/rebrand.mjs` 构建期字符串替换、仓库保持贴近上游——开发态与产物不一致，除非合并冲突成为长期痛点再考虑

## 4. 待决事项

- [ ] 正式产品名/appId 定名（建议形如 `com.uniround.vibby`）与协议 scheme（`vibby://`）
- [ ] Logo 素材：彩色 SVG 母版 + 单色剪影版（见 §1.5）
- [ ] 自有 Sentry / 分析方案，或决定摘除
- [ ] 更新源与发布仓库（GitHub Releases on UniRound-Tec/vibby）
- [ ] 配置同步功能去留（依赖 api.tabby.sh，见 §1.6）
- [ ] 插件市场策略：沿用 `tabby-plugin` 生态还是自有 keyword
