# M1 实施计划

> 执行依据：`04-m1-spec.md`（rev.2）。本文件只讲"怎么干、什么顺序、每步怎么验收、怎么切 commit"，规格细节一律引用 spec 章节不重复。
> 编写：2026-07-24

## 0. 开发环, 循环（每个工作包通用）

- 构建接线事实（已核对）：根 `webpack.config.mjs`、`scripts/install-deps.mjs`、`yarn watch` 均从 `scripts/vars.mjs` 的 `builtinPlugins` 枚举——**新插件接入点 = 该数组加一行** + 包内自带 webpack/tsconfig 样板（抄 `tabby-linkifier`，其结构：package.json / tsconfig.json / tsconfig.typings.json / webpack.config.mjs / src/）。
- 日常循环：`yarn watch`（覆盖所有插件包，含 tabby-ai）→ `yarn start`；渲染层排查用 `ELECTRON_ENABLE_LOGGING=1`。改的是插件不是 app/src，无需手动重编 app bundle。
- ⚠️ dev 数据隔离依赖 `node_modules/electron/dist/data` 目录（重装 node_modules 后要重建），否则会与正式版 Tabby 共享 %APPDATA%\Tabby。
- Windows 注意：install-deps 的 builtin 插件 symlink 步骤仅 darwin/linux——WP0 必须实测 dev 模式下插件从源码目录的加载路径，这是 WP0 唯一的未知数。

## 1. 工作包与顺序

依赖关系：WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6（WP3 的组件静态迁移可与 WP2 并行，数据接线需 WP1/WP2 产物）。

### WP0 骨架与构建接入
- 内容：`tabby-ai/` 样板（抄 linkifier，改 package.json 的 name/description/keywords/peerDeps：tabby-core/tabby-local/tabby-settings）；空 NgModule；`vars.mjs` 加行；跑 `install-deps` 或手动 `cd tabby-ai && yarn`。
- 完成判据：`yarn build` 全量通过；`yarn start` 后日志显示插件加载数 +1（12→13），应用行为无任何变化；**确认 Windows dev 加载路径**。
- Commit：`build: add tabby-ai plugin skeleton`（含 vars.mjs 触点）。

### WP1 注册表 + 扫描器
- 内容：spec §3 `registry.ts`（六条目，binaries 逐个 Windows 实测）、§4 `cliScanner.service.ts`（where/which → npm prefix → extraPaths；shim launcher 判定；版本探测 2s 超时 + 进程树清理；BehaviorSubject；hidden 过滤）。lobe-icons SVG 落 `src/icons/`（含许可注释，Aider 占位）。
- 完成判据：临时调试输出（或 devtools）打印本机 DetectedCli 列表，含正确的绝对路径/launcher 类型/版本号；人为造超时（如 versionArgs 改错）确认无进程残留。
- Commit：`feat(ai): CLI registry and scanner`。

### WP2 ProfileProvider + 启动包装 ⚠️ 风险闸门
- 内容：spec §5 全部（全量 configDefaults.options、`aiCli:{kind,version}`、buildLaunchOptions 三种 launcher、getDescription/getSuggestedName、cwd 继承）。
- 完成判据（含两个验证点，**不过则停下修改方案再继续**）：
  - 选择器出现 AI CLI 内置 profile，点击后 claude 正常进入交互界面（.cmd 经 cmd.exe /c 包装）；
  - **V1**：将 shim 复制到含空格路径下实测三种 launcher 启动；
  - **V2**：开一个 AI 会话 → 重启应用 → 会话恢复且 `profile.options.aiCli` 元数据完好（devtools 检查）。
- Commit：`feat(ai): AI CLI profile provider`。

### WP3 Dashboard 组件
- 内容：`dashboardTab.component` 静态迁移 demo V3（pug/scss，颜色→主题变量/ANSI 色位，字体→终端字体配置；`--stcol` 机制）；`cliChip.component`；`dashboard.service`（spec §7 的 split 递归会话发现 + 单实例 open/toggle）；站台条接 `scanResults$`，会话区接 rows，chip 点击 launchProfile，行点击跳转聚焦 pane。
- 完成判据：手动 `openNewTabRaw` 打开 Dashboard 验收——空状态/满载排版与 demo 一致；开 2 个 claude 会话（其中一个手动 split）后行数=2、点击各自聚焦正确 pane；关闭会话行消失、计数即时更新。
- Commit：`feat(ai): dashboard tab (V3 board)`。

### WP4 启动协调
- 内容：spec §7——`OpenDashboardCLIHandler`（priority 0 / firstMatchOnly / 严格匹配条件）；`configDefaults.yaml` 一行 `enableWelcomeTab: false`；`tabsChanged$` 重开；工具栏按钮；hotkeys 契约三件套（HotkeyProvider 描述 + config 默认键值 + hotkey$ 订阅）。
- 完成判据：验收标准 1/4/5/6 逐条过（干净启动只有 Dashboard；关光标签重开；重启恰好一个；按钮/热键/改键；`tabby <路径>` 与二次实例行为不变——二次实例场景用 `yarn start` 双开验证）。
- Commit：`feat(ai): startup coordination and dashboard entry points`（configDefaults.yaml 触点在 message 里注明）。

### WP5 设置页 + i18n
- 内容：spec §4 设置页（SettingsTabProvider + 重扫/extraPaths/hidden）；全组件字符串过 translate 管道；`locale/zh-CN.po` 增词条（核对上游 po 生成流程，手写词条格式与现有条目一致）。
- 完成判据：验收 7/8——隐藏条目后 chip 与内置 profile 同步消失；语言切到英文无汉字残留、切回中文全部命中。
- Commit：`feat(ai): settings tab and zh-CN locale`。

### WP6 收尾与合并演练
- 内容：九条验收标准全量回归一遍并记录结果；`git fetch upstream && git merge --no-commit --no-ff upstream/master` 演练，确认冲突面仅限 spec §9 清单，然后 `git merge --abort`；docs（04 spec 如有实现偏差回写）与记忆文件更新。
- 完成判据：验收 9；演练结论记入 docs。
- Commit：如有回写则 `docs: M1 implementation notes`。

## 2. Commit 纪律

- 一个 WP 一个 commit，上游文件改动（vars.mjs / configDefaults.yaml / locale）随所属 WP 提交但在 commit message 中单独点名——将来 merge 冲突时按 message 即可定位语义。
- 全程不顺手改动上游其他代码；发现上游 bug 单独记录不修（同步纪律，rebranding.md §3）。

## 3. 风险表

| 风险 | 位置 | 预案 |
|---|---|---|
| Windows dev 模式插件加载路径（无 symlink） | WP0 | 若加载失败：核对 `app/src/plugins.ts` 的 TABBY_DEV 路径逻辑，必要时把探明的机制记入 docs |
| .cmd shim 含空格路径（V1） | WP2 | 失败则 args 改为显式引号包装，记录 node-pty 行为差异 |
| ai-cli 恢复链路丢元数据（V2） | WP2 | 失败则在 provider 内做恢复兜底（token 补写 aiCli 字段）；仍不行降级记录、M2 前必须解决 |
| po 词条手写与上游生成流程冲突 | WP5 | 核对上游 extract 脚本；若自动生成则跑一遍工具而非手写 |

## 4. 完成定义

九条验收标准（spec §10）全绿 + WP6 合并演练通过 + 本文件与 spec 的偏差回写完成。
