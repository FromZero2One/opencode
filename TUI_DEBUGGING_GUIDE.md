# OpenCode TUI 操作流程与调试指南

## 目录

1. [架构概览](#1-架构概览)
2. [入口文件](#2-入口文件)
3. [完整启动流程](#3-完整启动流程)
4. [用户操作流程](#4-用户操作流程)
5. [调试方法](#5-调试方法)
6. [常用命令与参数](#6-常用命令与参数)
7. [环境变量](#7-环境变量)
8. [问题排查](#8-问题排查)
9. [VS Code 调试配置](#9-vs-code-调试配置)

---

## 1. 架构概览

TUI 采用**主进程 + Worker 进程**架构：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        主进程 (Main Thread)                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  CLI Command (src/cli/cmd/tui.ts)                             │  │
│  │    ├── 解析命令行参数                                          │  │
│  │    ├── 创建 Worker 进程                                        │  │
│  │    ├── 建立 RPC 通信                                           │  │
│  │    └── 启动 TUI (src/cli/tui/layer.ts)                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │  RPC 通信                            │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  TUI App (packages/tui/src/app.tsx)                           │  │
│  │    ├── OpenTUI 渲染器                                          │  │
│  │    ├── SolidJS 组件树                                          │  │
│  │    ├── SDKProvider (连接后端)                                   │  │
│  │    └── Route/Session 管理                                      │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                              │  Worker 线程
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Worker 进程                                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Worker (src/cli/tui/worker.ts)                               │  │
│  │    ├── 启动 HTTP Server                                        │  │
│  │    ├── 处理 RPC 调用 (fetch/server/shutdown)                   │  │
│  │    ├── 全局事件总线 (GlobalBus)                                 │  │
│  │    └── 实例运行时管理 (InstanceRuntime)                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**通信模式**:
- **内部模式**: TUI 通过 RPC 调用 Worker 进程的 `fetch` 方法
- **外部模式**: TUI 通过 HTTP 直接连接外部 Server（使用 `--port` 等网络参数时）

---

## 2. 入口文件

### 2.1 CLI 命令入口

**文件**: `packages/opencode/src/cli/cmd/tui.ts`

**核心职责**:
- 解析命令行参数（yargs）
- 创建 Worker 进程
- 建立 RPC 通信通道
- 调用 TUI 运行层

**关键代码**:
```ts
export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  builder: (yargs) => withNetworkOptions(yargs)
    .positional("project", { type: "string" })
    .option("model", { alias: ["m"] })
    .option("continue", { alias: ["c"] })
    ...
  handler: async (args) => {
    const worker = new Worker(file)
    const client = Rpc.client<typeof rpc>(worker)
    
    const transport = external
      ? { url: ..., fetch: undefined }
      : { url: "http://opencode.internal",
          fetch: createWorkerFetch(client),
          events: createEventSource(client) }
    
    const { run } = await import("../tui/layer")
    await Effect.runPromise(run({ ...transport, args }))
  }
})
```

### 2.2 TUI 运行层

**文件**: `packages/opencode/src/cli/tui/layer.ts`

**核心职责**: 注入全局服务依赖，调用 TUI 包的 `run` 函数

```ts
import { run as runTui, type TuiInput } from "@opencode-ai/tui"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
```

### 2.3 TUI 核心应用

**文件**: `packages/tui/src/app.tsx`

**核心职责**:
- 创建 OpenTUI 渲染器
- 渲染 SolidJS 组件树
- 管理应用生命周期
- 提供全局上下文（SDK、路由、主题等）

**TuiInput 类型**:
```ts
export type TuiInput = {
  url: string              // 后端 URL
  args: Args               // 命令行参数
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  directory?: string       // 当前目录
  fetch?: typeof fetch     // 自定义 fetch
  headers?: RequestInit["headers"]
  events?: EventSource     // 事件源
  pluginHost: TuiPluginHost
}
```

### 2.4 Worker 进程

**文件**: `packages/opencode/src/cli/tui/worker.ts`

**RPC 接口**:
| 方法 | 说明 |
|------|------|
| `fetch` | 代理 HTTP 请求到 Server |
| `snapshot` | 写入堆快照 |
| `server` | 启动外部 HTTP Server |
| `checkUpgrade` | 检查更新 |
| `reload` | 重载配置 |
| `shutdown` | 关闭 Worker |

---

## 3. 完整启动流程

```
用户执行: bun dev
        │
        ▼
┌─────────────────────────────────────┐
│  packages/opencode/src/index.ts    │  ← CLI 入口
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  TuiThreadCommand.handler()        │  ← 解析参数
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  创建 Worker 进程                   │  ← new Worker(file)
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  Worker 启动 Server                 │  ← Server.Default()
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  建立 RPC 通信通道                   │  ← createWorkerFetch()
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  runTui() → createCliRenderer()    │  ← 创建终端渲染器
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  render(<App />) → SolidJS 渲染     │  ← 渲染组件树
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  SDKProvider 连接后端               │  ← 通过 RPC/HTTP
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  显示 Home 页面                     │  ← 用户可以输入 prompt
└─────────────────────────────────────┘
```

---

## 4. 用户操作流程

### 4.1 输入 Prompt 流程

```
用户输入 "给我生成一个冒泡算法"
        │
        ▼
┌─────────────────────────────────────┐
│  PromptInput 组件                   │  ← 捕获输入
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  SDKProvider → SDK Client          │  ← 调用 client.session.prompt()
└─────────────────────────────────────┘
        │  HTTP/RPC 请求
        ▼
┌─────────────────────────────────────┐
│  Server (Hono) → SessionHandler    │  ← 路由匹配
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  SessionV2.prompt()                │  ← 核心处理
│    ├── 持久化 session_input        │  │
│    └── 触发 SessionExecution.wake()│  │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  SessionRunCoordinator             │  ← 合并唤醒请求
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  SessionRunner.run()               │  ← 执行会话
│    ├── runTurn() → 构建 LLM 请求    │  │
│    ├── llm.stream() → 调用模型      │  │
│    └── 发布 SessionEvent           │  │
└─────────────────────────────────────┘
        │  SSE 事件流
        ▼
┌─────────────────────────────────────┐
│  SDKProvider 接收事件               │  ← 更新 UI
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  Session 组件显示响应               │  ← 用户看到结果
└─────────────────────────────────────┘
```

### 4.2 路由切换流程

```
用户按 "/" 打开命令面板
        │
        ▼
┌─────────────────────────────────────┐
│  CommandPaletteDialog              │  ← 显示命令列表
└─────────────────────────────────────┘
        │ 用户选择命令
        ▼
┌─────────────────────────────────────┐
│  useRoute().navigate()             │  ← 更新路由状态
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  Switch/Match 组件                 │  ← 渲染对应页面
└─────────────────────────────────────┘
```

---

## 5. 调试方法

### 5.1 开发模式运行（推荐）

```bash
cd packages/opencode
bun dev
```

**注意**: `bun dev` 会启动交互式 TUI，会阻塞终端。如需同时查看其他内容：

```bash
# 在 tmux 后台启动
tmux new-session -d -s opencode-dev 'bun dev'

# 查看 TUI 输出
tmux capture-pane -pt opencode-dev

# 进入 TUI 会话
tmux attach -t opencode-dev

# 停止
tmux kill-session -t opencode-dev
```

### 5.2 TUI 内置调试工具

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| `app.debug` | - | 切换调试面板 |
| `app.console` | - | 切换 OpenTUI 控制台 |
| `app.heap_snapshot` | - | 写入堆快照 |
| `opencode.debug` | `/debug` | 显示调试信息对话框 |
| `opencode.status` | `/status` | 显示系统状态对话框 |

**使用方式**:
1. 按 `/` 打开命令面板
2. 输入命令名称（如 `debug`）
3. 选择对应命令

### 5.3 Mini 模式快速测试

```bash
bun dev --mini --prompt "给我生成一个冒泡算法"
```

**优点**:
- 启动更快（跳过部分初始化）
- 适合快速验证流程
- 自动退出

### 5.4 日志输出

```bash
# 重定向到文件
bun dev 2>&1 | tee opencode.log

# 实时查看
tail -f opencode.log
```

### 5.5 堆快照分析

1. 在 TUI 中输入 `/heap` 打开命令面板
2. 选择 `Write heap snapshot`
3. 快照会写入当前目录：
   - `tui.heapsnapshot` - TUI 进程
   - `server.heapsnapshot` - Worker/Server 进程

4. 在 Chrome DevTools 中分析：
   - 打开 Chrome → F12 → Memory → Load

### 5.6 断点调试

**VS Code 配置**（见第 9 节）

### 5.7 发送 SIGUSR2 重载配置

```bash
# 获取进程 ID
ps aux | grep opencode

# 发送重载信号
kill -USR2 <pid>
```

Worker 会执行 `reload` RPC 方法：
- 使配置失效
- 释放所有实例
- 触发全局 Disposed 事件

---

## 6. 常用命令与参数

### 6.1 启动命令

```bash
# 默认启动
bun dev

# 指定项目目录
bun dev /path/to/project

# 继续上一个会话
bun dev -c

# 指定会话 ID
bun dev -s ses_xxx

# 指定模型
bun dev -m openai/gpt-4o-mini

# 指定 Agent
bun dev --agent default

# Fork 会话
bun dev -c --fork

# 使用 mini 模式
bun dev --mini

# 使用 mini 模式并指定 prompt
bun dev --mini --prompt "生成冒泡算法"
```

### 6.2 命令行参数表

| 参数 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `[project]` | - | string | 项目路径 |
| `--model` | `-m` | string | 指定模型 (provider/model) |
| `--continue` | `-c` | boolean | 继续上一个会话 |
| `--session` | `-s` | string | 指定会话 ID |
| `--fork` | - | boolean | fork 会话（需配合 -c 或 -s） |
| `--prompt` | - | string | 初始 prompt |
| `--agent` | - | string | 指定 agent |
| `--auto` | - | boolean | 自动批准权限 |
| `--mini` | - | boolean | 启动精简版界面 |
| `--port` | - | number | 指定端口（外部模式） |
| `--hostname` | - | string | 指定主机名 |
| `--mdns` | - | boolean | 启用 mDNS |

---

## 7. 环境变量

| 变量 | 说明 |
|------|------|
| `OPENCODE_ROUTE` | 指定初始路由，如 `{"type":"home"}` |
| `OPENCODE_FAST_BOOT` | 跳过初始加载动画 |
| `OPENCODE_DISABLE_MOUSE` | 禁用鼠标支持 |
| `OPENCODE_SHOW_TTFD` | 显示 Time To First Draw 指标 |
| `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT` | 禁用选择时自动复制 |

**使用示例**:
```bash
OPENCODE_FAST_BOOT=1 OPENCODE_ROUTE='{"type":"home"}' bun dev
```

---

## 8. 问题排查

### 8.1 启动失败

**检查项**:
1. Node.js/Bun 版本是否符合要求
2. 依赖是否已安装（`bun install`）
3. 端口是否被占用
4. 日志中是否有错误信息

**常见错误**:
```
# 端口占用
Error: listen EADDRINUSE: address already in use :::8080

# 依赖缺失
Error: Cannot find module '@opencode-ai/tui'

# 权限问题
Error: EACCES: permission denied
```

### 8.2 TUI 界面无响应

**排查步骤**:
1. 检查是否有 JavaScript 错误（按 `app.console` 打开控制台）
2. 检查网络请求（使用 `/status` 查看连接状态）
3. 检查 Server 是否正常运行
4. 尝试重启应用

### 8.3 会话执行异常

**排查步骤**:
1. 使用 `/debug` 查看调试信息
2. 查看日志文件中的错误
3. 检查模型配置是否正确
4. 检查 API Key 是否有效
5. 使用 `/status` 查看会话状态

### 8.4 内存泄漏

**排查步骤**:
1. 定期写入堆快照（`app.heap_snapshot`）
2. 在 Chrome DevTools 中分析快照
3. 比较多个快照，找出增长的对象
4. 检查 Effect 资源是否正确释放

---

## 9. VS Code 调试配置

### 9.1 配置文件

创建 `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "bun",
      "request": "launch",
      "name": "TUI Debug",
      "cwd": "${workspaceFolder}/packages/opencode",
      "program": "./src/index.ts",
      "args": ["--mini", "--prompt", "hello"],
      "env": {
        "OPENCODE_ROUTE": "{\"type\":\"home\"}",
        "OPENCODE_FAST_BOOT": "1"
      },
      "console": "integratedTerminal",
      "stopOnEntry": false
    },
    {
      "type": "bun",
      "request": "launch",
      "name": "TUI Debug (Full)",
      "cwd": "${workspaceFolder}/packages/opencode",
      "program": "./src/index.ts",
      "env": {
        "OPENCODE_FAST_BOOT": "1"
      },
      "console": "externalTerminal",
      "stopOnEntry": false
    }
  ]
}
```

### 9.2 常用断点位置

| 文件 | 行号 | 说明 |
|------|------|------|
| `packages/tui/src/app.tsx` | 186 | TUI 启动入口 |
| `packages/tui/src/routes/session.tsx` | - | 会话页面渲染 |
| `packages/tui/src/context/sdk.tsx` | - | SDK 初始化 |
| `packages/sdk/js/src/v2/client.ts` | - | SDK 客户端请求 |
| `packages/server/src/handlers/session.ts` | - | Session API 处理 |
| `packages/core/src/session.ts` | - | SessionV2 核心逻辑 |
| `packages/core/src/session/runner/llm.ts` | - | 会话执行 |

### 9.3 调试技巧

1. **条件断点**: 在 `SessionRunner.run()` 中设置条件，只在特定 sessionID 时触发
2. **日志断点**: 使用 `console.log` 输出中间状态，不中断执行
3. **Watch 表达式**: 监控 `sync.status`、`route.data` 等关键状态
4. **步进调试**: 使用 F10/F11 逐步执行，观察每一步的变化

---

## 附录：文件路径速查

| 组件 | 文件路径 |
|------|----------|
| CLI 命令 | `packages/opencode/src/cli/cmd/tui.ts` |
| TUI 运行层 | `packages/opencode/src/cli/tui/layer.ts` |
| Worker 进程 | `packages/opencode/src/cli/tui/worker.ts` |
| TUI 核心应用 | `packages/tui/src/app.tsx` |
| TUI 路由 | `packages/tui/src/context/route.tsx` |
| SDK Provider | `packages/tui/src/context/sdk.tsx` |
| Session 页面 | `packages/tui/src/routes/session.tsx` |
| SDK 客户端 | `packages/sdk/js/src/v2/client.ts` |
| Server 路由 | `packages/server/src/routes.ts` |
| Session 处理 | `packages/server/src/handlers/session.ts` |
| SessionV2 核心 | `packages/core/src/session.ts` |
| SessionRunner | `packages/core/src/session/runner/llm.ts` |

---

**文档版本**: 1.0  
**生成日期**: 2026-07-08  
**适用项目**: OpenCode