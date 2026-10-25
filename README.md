# dsh-git-branch-pill

[![npm](https://img.shields.io/badge/install-github%3Agithub1359930721%2Fdsh-git-branch-pill-4c6ef5)](https://github.com/github1359930721/dsh-git-branch-pill)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

DeepSeek Harness (DSH) Web 插件：在**每个会话**的输入框下方 dock 里显示该会话工作目录当前的 Git 分支，**包括正在对话的 active 会话**。

两个卖点：

- **所有会话都看得见**，不止新建会话页
- **非 Git 目录也不会消失** —— 显示灰色的 `⎇ 非 Git`，而不是整块不渲染

修的是「分支名只有新建会话页能看到」的问题：原生 workspace 胶囊和 `@linxin666/dsh-client-ui-git-graph` 的分支选择器都只挂在英雄区（blank 空态）出现，这个胶囊挂在 `conversation.composer.dock`，所以老会话、跑着的会话同样可见。

## 一个会话里能看到的四种状态

「什么都不显示」是最差的反馈：既可能是「这里确实没有分支」，也可能是「插件根本挂了」，两者在界面上完全一样。所以本插件**永远占住一个分支位**：

| 状态 | 界面 | 含义 |
| --- | --- | --- |
| 仓库有分支 | `⎇ main` | 正常，可点击复制/切换 |
| 非 Git 目录 | 灰色虚线 `⎇ 非 Git` | 这个目录没被 git 管，不是错误 |
| 仓库但没有 HEAD | 灰色虚线 `⎇ 无分支` | 空仓库（还没有第一次提交） |
| 查询失败 | 黄色 `⚠ 分支未知` | 网络 / 401 / Host 超时 / 找不到 git / 路径非法，hover 看原因 |

核心取舍：**宁可显示一个弱化的「没有」，也不要显示一个看不出原因的空白。**

## 新增操作与工作区状态（v1.2.0）

- 胶囊旁的 `↻` 可手动刷新；首次查询失败、非 Git 或无分支状态也提供重试按钮。刷新期间保留原标签并显示忙碌状态。
- 网络或 Git 查询失败时保留最后成功的分支，显示警告标记；悬浮提示最后成功时间，恢复后清除警告。
- 胶囊显示 `· 有改动`；菜单中显示修改、未跟踪、冲突计数。工作区扫描每 30s 一次，失败也按 30s 退避；页面隐藏时暂停，手动刷新可绕过缓存。
- 右键胶囊可打开操作菜单；即使没有 git-graph，也可复制分支名、刷新。已有普通点击和 Ctrl/Cmd 点击行为保持不变。
- 分支菜单提供显式复制、刷新操作，当前分支置顶并保留；无匹配结果与无本地分支分别提示。上下方向键导航，Enter 确认，Escape 关闭，完整分支名可悬浮查看。

工作区查询由本插件独立提供 `GET /api/dsh-git-status?cwd=<绝对路径>[&fresh=1]`，不依赖 git-graph。使用 `git --no-optional-locks status --porcelain=v1 -z --untracked-files=normal`，按仓库范围统计，不更改 Git 索引。重命名仅计一次；冲突与修改分开计数。未跟踪目录按 Git normal 模式合并计数，并非逐文件展开。状态查询失败不会伪装为干净状态；输出超过 4MiB 或整次查询超过 4s 时显示未知/过期提示。

## 与 git-graph 协作（可选）

装了 [`@linxin666/dsh-client-ui-git-graph`](https://www.npmjs.com/package/@linxin666/dsh-client-ui-git-graph) 时，胶囊**升级为可切换分支**：

- **普通点击** → 弹出可筛选的分支列表，选中即切换（真实执行 `git switch`，含它的冲突/占用守卫）
- **Ctrl+点击**（macOS 为 Cmd+点击）→ 复制分支名
- 下拉箭头只有在该插件可用时才出现；没装则点击退回「复制分支名」

桥接方式**不是导入**它的代码，而是复用它 Host 半已经注册的路由：

| 路由 | 用途 |
| --- | --- |
| `POST /git/config` | 探测插件是否在线（也拿 worktreesHome） |
| `POST /git/branches` | `{ path }` → 分支列表 + 当前分支 + 脏文件数 |
| `POST /git/status` | `{ path }` → 仓库快照 |
| `POST /git/switch` | `{ path, branch }` → 真正切分支 |

因此：git-graph 不可用时胶囊退回只读复制，不影响分支显示。页面内共享探测请求，成功结果缓存 60s、失败结果缓存 15s；轮询会重新探测，网络恢复时立即重试。路由协议不兼容时会显示错误，不会直接导入另一插件的代码。

## 它做什么

- Host 半（`index.js`）注册 `GET /api/dsh-git-branch?cwd=<绝对路径>[&fresh=1]`，在会话工作目录里跑 `git symbolic-ref --short HEAD`，失败时退回 `rev-parse --short HEAD`（分离 HEAD 显示为 `分离 HEAD · <sha>`）。
- Client 半（`client.js`）注册 `conversation.composer.dock` 条目，`useSessions` 取当前会话 `cwd`，**每 3 秒轮询一次**（页面隐藏时暂停，`visibilitychange` 恢复后立刻补一次且带 `fresh=1`）。
- **点击胶囊复制分支名**（hover 有提示，成功后有 1.2s 的「已复制」反馈）。
- Host 缓存 **2s**（成功）/ 8s（非仓库或失败），**LRU** 淘汰、最长 256 项；同目录并发查询共享任务，整次查询（目录检查、Git 解析和所有命令）共用 **4s** 超时预算。
- Git 缺失、权限错误、查询超时和其他执行错误分别提示，不再把执行失败当成「非 Git」。Git 解析失败缓存 8s 后可重试。
- 切换成功会使旧查询失效并重新确认分支；迟到响应不会覆盖新状态。复制失败也会给出短暂反馈。

### 四种结果，分得清

「什么都不显示」没法排查，所以状态是分开的：

| 情况 | 界面 | 原因 |
| --- | --- | --- |
| 确认是 git 仓库 | `⎇ 分支名`，可点复制/切换 | — |
| 确认不是仓库 | 灰色虚线 `⎇ 非 Git`，hover 说明，不可点 | 分支位不消失，普通文件夹会话也不会看起来像插件坏了 |
| 仓库但读不出分支（空仓库） | 灰色虚线 `⎇ 无分支` | 有仓库无 HEAD，仍是正常状态 |
| 结果未知（网络 / 401 / Host 超时） | 黄色 `⚠ 分支未知`，hover 说明原因 | 失败可自愈，但不能装死 |
| 工作目录已不存在 | 黄色 `⚠ 分支未知` | 提示目录被删/改名 |
| 找不到 `git` 可执行文件 | 黄色 `⚠ 分支未知`，提示检查 PATH | Electron 主进程的 PATH 常比终端窄 |
| 工作目录不是绝对路径 | 黄色 `⚠ 分支未知` | 会话数据异常，值得暴露 |

> 早期版本对「确认不是仓库」直接不渲染，表现为**切到非 git 会话时胶囊整块消失**，
> 和「插件没加载」无法区分。现在改成弱化的 `非 Git` 胶囊，任何会话的 dock 里都恒有一个分支位。

Client 使用 5s 的 `AbortSignal.timeout` 限制请求等待；Host 整次查询预算为 4s。请求断开时，若没有其他共享调用者，Host 会取消任务并终止活动 Git 子进程。客户端缓存只用于立即显示，不能阻断后续轮询。

自定义 Web 路由必须经过宿主 `connection.requestRejection` 的跨站/登录态检查。本插件声明 `connection` 依赖；若该能力不可用，接口返回 503 `auth-unavailable`，不会继续查询目录。旧宿主缺少这项能力时需要升级，不能绕过鉴权。

### 轮询成本

每个可见会话每 3s 一个请求；Host 同目录并发去重与 2s 缓存限制重复查询。一次普通分支查询通常执行两条 Git 命令，分离 HEAD 通常执行三条。页面隐藏时暂停；远程/SSH 工作区需要按实际往返成本评估轮询间隔。

Console 只在**每种失败首次出现时**记录一次，不会每 3 秒刷屏。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch` + **`dsh.client`** + `./client` 导出 |
| `cordis.patch.yml` | 插入一行 `dsh-git-branch-pill` |
| `index.js` | Host 半：认证后的分支查询端点 |
| `client.js` | Client 半：`window.__ModuleLoader__` 工厂 + dock 胶囊组件 |
| `locale/{zh,en}.json` | 插件标题/描述与胶囊文案 |
| `icon.svg` | 插件管理面板图标 |
| `tests/` | 不依赖浏览器的自检脚本（见下） |

## 安装

### 从 GitHub 装（推荐，适用于任何 profile）

```bash
# 普通 dsh（web profile 等）
dsh plugin --profile web add github:github1359930721/dsh-git-branch-pill

# 从本地克隆的目录装
dsh plugin --profile web add /path/to/dsh-git-branch-pill
```

装完**刷新页面**。桌面版（Electron 独占 `desktop` profile）的安装命令见下方。

### 桌面版（Desktop）

Desktop 由 Electron 应用独占 `desktop` profile，普通 `dsh plugin` 会被拒绝，要用应用自带的 CLI：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
$env:DSH_HOME = "E:\DSH-Data"
& "E:\dsh\DeepSeek Harness.exe" --expose-internals `
  "E:\dsh\resources\app\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile desktop add "github:github1359930721/dsh-git-branch-pill"
```

装完在 `<DSH_HOME>/profiles/<profile>/package.json` 里同时出现 `dependencies` 与 `dsh.profile.bundles` 两处条目。**刷新页面**后生效。

> 从本地目录安装（`add /path/to/pkg`）会在 `node_modules` 下建 junction，改代码即时生效；
> 从 GitHub 安装则装的是快照副本，更新要重新 `add`。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-git-branch-pill
```

## 自检

在受支持的 Node（`^22.19.0 || >=24.0.0`）与 Git 环境中运行：

```bash
npm test                 # 语法、客户端/Host 行为、静态加载、临时仓库集成检查
npm run test:behavior    # 仅运行模拟网络、时钟和子进程的行为回归
```

不需要安装依赖。默认测试不会访问真实 DSH 或切换业务仓库分支；Git 集成检查只操作自己创建的临时仓库。Host 测试使用 Node VM Modules，运行时会出现实验性 API 警告，不影响测试结论。CI 配置覆盖 Windows/Linux、Node 22.19 与 24。

以下为单项检查及需要本机 DSH 安装的诊断脚本；后者不纳入 `npm test`：

```bash
node tests/handler-check.mjs        # 端点：真实仓库 / 非仓库 / 缺失目录 / 相对路径 / 方法
node tests/host-hardening.mjs       # Host 加固：git 解析、git 缺失上报、LRU 容量压测
node tests/poll-behavior.mjs        # 切分支可见性：缓存命中 / fresh=1 / TTL 后轮询 / 分离 HEAD
node tests/client-check.mjs         # client bundle：manifest dsh.client、inject、slot 注册、locale、六种渲染状态
node tests/bridge-check.mjs         # git-graph 桥接降级：无该插件时点击安全、不渲染菜单
node tests/composed-row-check.mjs   # 端到端：profile 清单 + 行解析 + 工厂 require 是否都是 seed 模块
node tests/activation-scan.mjs      # 对比官方插件的清单声明（排查「不渲染」）
node tests/profile-check.mjs        # profile 层里是否有本 bundle
node tests/client-graph-check.mjs   # 同上，含 bundle 目录与 patch 路径
node tests/sessions-by-cwd.mjs      # 按工作目录分组已有会话（用于挑最早的会话做验证）
node tests/loader-contract.mjs      # 页面模块表的 require 契约（排查 require 未命中）

# 需要正在运行的 DSH Web UI + 已装 git-graph：
node tests/git-graph-live.mjs  http://127.0.0.1:<port> <目录>   # 路由是否 MOUNTED（404=插件没装）
node tests/git-graph-read.mjs  http://127.0.0.1:<port> <目录>   # 真读分支列表
```

`handler-check`、`host-hardening` 与 `poll-behavior` 需要本机有 `git`，均使用临时仓库。profile、装配、loader 与会话数据诊断脚本依赖本机 DSH 安装和路径，需按实际环境调整。

## 踩过的坑（改代码前先看）

### 1. 非 Git 会话里胶囊整块消失（v1.1.1 修复）

**现象**：切到一个工作目录不是 git 仓库的会话，分支胶囊直接不见了。看起来像插件没加载、或者宿主更新把插件搞坏了，但别的会话里它明明好好的。

**原因**：早期代码把「确认不是仓库」当成正常情况，在 `!answer.repo` 分支末尾直接 `return null`——组件返回 `null`，dock 里就什么都不占。于是同一个页面里出现两种完全不同的语义，界面上却都是「空白」：

```js
// 旧代码
if (!answer.repo) {
  if (answer.reason === 'missing-directory') return warningPill
  if (answer.gitMissing === true) return warningPill
  return null          // ← 非 Git 目录：什么都没渲染
}
```

**修复**：非仓库也渲染一个 `data-state="plain"` 的弱化胶囊（灰色、虚线边框、不可点），文案 `非 Git`，hover 带上完整目录路径。同时补上 `invalid-directory` 与「仓库但无分支」两个分支，四态彻底分开。

**教训**：在「多状态合并成一个 dock 位」的 UI 里，**空渲染必须被当成一种错误处理方式**来看待，而不是一种正常输出。只要用户无法区分「无数据」和「无功能」，任何一个状态缺失都会被读成 bug——而这个 bug 又会掩盖真正的 bug。要么渲染占位，要么暴露原因，不要留白。

### 2. `dsh.client` 声明不能省

少了这个块，`dsh-client-modules` 的扫描直接跳过本包，Host 半照样挂载（端点返回 401 而不是 404，看起来一切正常），但浏览器端永远不加载。表现为「界面里什么都没有」。排查时先确认这一条：`dsh.client.platform` 必须是 `web`，并且 `exports["./client"]` 指向真实文件。

### 3. `factory(require)` 只能 require 页面 seed 模块

页面注入的 `require` 只认 shell 预先 seed 的模块：

`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`。

`@deepseek-ai/dsh-client-ui-primitives` **不导出 React**，只有顶层 `react` 才是 React。其他依赖要么显式写进 `dsh.client.external`，要么改成 Vite 构建产物。`tests/composed-row-check.mjs` 就是对这条的自检。

### 4. Host 端 endpoint 永远返回 JSON，不要漏掉鉴权

`requestRejection`（宿主自带的跨站/未登录判定）必须在最前面。漏了它，页面拿不到分支、只在 console 里报一个 fetch 失败，胶囊表现为「分支未知」，很难反查到是认证问题。

### 5. 主题变量名要跟宿主对齐

胶囊的弱化色一度写了 `--dsh-text-tertiary`——宿主根本没有定义这个变量，于是 `plain` 状态静默回退成正文色，看起来跟正常分支一样重。宿主实际用的是 `--dsw-alias-label-tertiary`。**改配色前先在 `dsh-client-ui-*` 的 CSS 里确认变量真的存在**，别按直觉命名。

### 6. 从 GitHub 安装的是快照，不是 junction

`dsh plugin add github:...` 会把包**拷贝**到 `<DSH_HOME>/profiles/<profile>/node_modules/`，不是软链。所以本地改完 `client.js` 后，**必须同步到 profile 目录再刷新页面**，否则你在浏览器里验证的仍然是被改坏的旧版本——这个坑会让人怀疑自己改的代码没生效。

## 已知限制

- 分支更新靠轮询：正常查询时 `git checkout` 后约一个 **3s** 轮询周期加查询耗时可见；非仓库/失败结果的 Host 缓存最长 8s。页面隐藏时暂停，回到前台或恢复联网立即刷新。
- 只读 `cwd`，工作区状态每 30s 刷新；不显示领先/落后上游，不执行 fetch、stash 或强制切换。
- 只覆盖 Web/Desktop 页面；不涉及 App 原生端。
