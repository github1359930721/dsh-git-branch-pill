# dsh-git-branch-pill

[![npm](https://img.shields.io/badge/install-github%3Agithub1359930721%2Fdsh-git-branch-pill-4c6ef5)](https://github.com/github1359930721/dsh-git-branch-pill)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

DeepSeek Harness (DSH) Web 插件：在**每个会话**的输入框下方 dock 里显示该会话工作目录当前的 Git 分支，**包括正在对话的 active 会话**。

修的是「分支名只有新建会话页能看到」的问题：原生 workspace 胶囊和 `@linxin666/dsh-client-ui-git-graph` 的分支选择器都只挂在英雄区（blank 空态）出现，这个胶囊挂在 `conversation.composer.dock`，所以老会话、跑着的会话同样可见。

> 与 git-graph 的区别：那个是**分支选择器**（能切分支，仅 blank 会话）；这个是**状态显示**（只读，所有会话）。两者可共存。

## 安装

```bash
dsh plugin --profile web add github:github1359930721/dsh-git-branch-pill
```

装完**刷新页面**。桌面版（Electron 独占 `desktop` profile）的安装命令见下方。

## 它做什么

- Host 半（`index.js`）注册 `GET /api/dsh-git-branch?cwd=<绝对路径>[&fresh=1]`，在会话工作目录里跑 `git symbolic-ref --short HEAD`，失败时退回 `rev-parse --short HEAD`（分离 HEAD 显示为 `分离 HEAD · <sha>`）。
- Client 半（`client.js`）注册 `conversation.composer.dock` 条目，`useSessions` 取当前会话 `cwd`，**每 3 秒轮询一次**（页面隐藏时暂停，`visibilitychange` 恢复后立刻补一次且带 `fresh=1`）。
- **点击胶囊复制分支名**（hover 有提示，成功后有 1.2s 的「已复制」反馈）。
- Host 缓存 **2s**（成功）/ 8s（失败），**LRU** 淘汰、最长 256 项；`git` 调用 4s 超时，绝不拖住 UI。

### 三种结果，分得清

「什么都不显示」没法排查，所以状态是分开的：

| 情况 | 界面 | 原因 |
| --- | --- | --- |
| 确认是 git 仓库 | `⎇ 分支名`，可点复制 | — |
| 确认不是仓库 | **不渲染** | 保持普通文件夹会话干净 |
| 结果未知（网络 / 401 / Host 超时 / git 缺失） | 黄色 `⚠ 分支未知`，hover 说明原因 | 失败可自愈，但不能装死 |
| 工作目录已不存在 | 黄色 `⚠ 分支未知` | 提示目录被删/改名 |
| 找不到 `git` 可执行文件 | 黄色 `⚠ 分支未知`，提示检查 PATH | Electron 主进程的 PATH 常比终端窄 |

Host 有一道 5s 的 `AbortSignal.timeout`：否则一个卡住的请求会占住 `inFlight` 去重表，让后续每 3s 的 tick 全部复用这个挂起的 Promise，胶囊**永久静默**。

### 轮询成本

每个可见会话每 3s 一个请求，但 Host 端 2s 缓存意味着**同一目录平均每 2–3s 才 spawn 一次 `git`**；页面隐藏（切标签、最小化）时完全停摆。远程/SSH 工作区要按跨越网络的往返成本重新评估这个间隔。

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

```bash
node tests/handler-check.mjs        # 端点：真实仓库 / 非仓库 / 缺失目录 / 相对路径 / 方法
node tests/host-hardening.mjs       # Host 加固：git 解析、git 缺失上报、LRU 容量压测
node tests/poll-behavior.mjs        # 切分支可见性：缓存命中 / fresh=1 / TTL 后轮询 / 分离 HEAD
node tests/client-check.mjs         # client bundle：manifest dsh.client、inject、slot 注册、locale、五种渲染状态
node tests/composed-row-check.mjs   # 端到端：profile 清单 + 行解析 + 工厂 require 是否都是 seed 模块
node tests/activation-scan.mjs      # 对比官方插件的清单声明（排查「不渲染」）
node tests/profile-check.mjs        # profile 层里是否有本 bundle
node tests/client-graph-check.mjs   # 同上，含 bundle 目录与 patch 路径
node tests/sessions-by-cwd.mjs      # 按工作目录分组已有会话（用于挑最早的会话做验证）
node tests/loader-contract.mjs      # 页面模块表的 require 契约（排查 require 未命中）
```

`handler-check`、`host-hardening` 与 `poll-behavior` 需要本机有 `git`（后者会建临时仓库并真的切分支）；其余纯 Node。

## 两个曾经踩过的坑（改代码前先看）

1. **`dsh.client` 声明不能省**。少了这个块，`dsh-client-modules` 的扫描直接跳过本包，
   Host 半照样挂载（端点 401 而不是 404），但浏览器端永远不加载 —— 表现为「什么都不显示」。
2. **`factory(require)` 只能 require 页面 seed 模块**：`react`、`react/jsx-runtime`、`react-dom`、
   `@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、
   `dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`。
   `@deepseek-ai/dsh-client-ui-primitives` **不导出 React**，只有顶层 `react` 才是 React。
   其他依赖只能显式写进 `dsh.client.external`，或改用 Vite 构建产物。

## 已知限制

- 分支更新靠轮询：`git checkout` 后最长 **3s**（轮询）可见；页面隐藏时暂停，回到前台立刻刷新。
- 只读 `cwd`，不显示未提交改动、领先/落后上游——按需求只要分支名。
- 只覆盖 Web/Desktop 页面；不涉及 App 原生端。
