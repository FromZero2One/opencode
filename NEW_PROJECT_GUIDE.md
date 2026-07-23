# 快速熟悉一个新项目的方法

> 适用于基于 TypeScript / Node.js / Bun 的开源项目。

---

## 1. 第一层：顶层文件扫描

```text
项目根目录/
├── package.json          ← 项目名称、依赖（dependencies / devDependencies）、scripts
├── README.md             ← 官方介绍、安装方式、使用说明
├── CONTRIBUTING.md       ← 贡献指南、开发环境搭建、PR 规范
├── CONTEXT.md            ← 项目架构设计说明（如果存在，优先读）
├── AGENTS.md             ← Agent 系统说明（如果存在）
├── tsconfig.json         ← TypeScript 编译配置
├── bunfig.toml           ← Bun 运行时配置
├── .github/workflows/    ← CI/CD 自动流程
└── packages/             ← monorepo 子包
```

> **目的**：判断技术栈、项目结构（单体 / monorepo）、启动方式。

---

## 2. 第二层：看目录结构

```
src/
├── index.ts              ← 🚪 入口文件（最重要的起点）
├── cli/                  ← CLI 命令定义
├── server/               ← 后端 HTTP 服务
├── client/               ← 客户端 / SDK
├── session/              ← 核心业务流程
├── agent/                ← Agent 业务模块
└── ...
```

> **目的**：目录名 = 模块职责声明，扫一遍即可画出架构草图。

---

## 3. 第三层：跟踪入口调用链

从 `index.ts` 开始，顺藤摸瓜：

```
index.ts
  └─ cli/cmd/serve.ts
       └─ server/server.ts
            └─ HttpRouter.serve(...)
```

> **目的**：理解程序启动后的完整执行路径。

---

## 4. 第四层：理解核心抽象

识别项目使用了什么编程模型。例如本项目使用了 **Effect** 架构：

```ts
// Effect 类型：描述一个计算
Effect<Success, Error, RequiredDependencies>

// 组合方式
pipe(
  effect1,
  Effect.flatMap(() => effect2),
  Effect.provide(layer)  // 注入依赖
)
```

项目中高频出现的模式：

| 语法 | 含义 |
|------|------|
| `yield*` | Effect 中的 await |
| `Effect.fn("name")` | 定义一个 Effect 函数 |
| `Layer` | 依赖注入层 |
| `Effect.provide(layer)` | 注入依赖 |
| `Effect.runPromise` | 将 Effect 转为 Promise 执行 |
| `pipe` | 函数式管道操作 |

> **目的**：只有理解核心抽象，才能读懂业务代码逻辑。

---

## 5. 第五层：追踪一个完整业务流程

选一个核心功能，从用户操作到最终响应全链路追踪。例如"用户发送一条消息"：

```
用户输入 prompt
  → TUI PromptInput 组件
    → SDK Client 发送请求
      → Server SessionHandler
        → SessionRunner.run()
          → LLM 模型调用
            → 流式返回结果
```

> **目的**：将代码结构与实际业务流程串起来。

---

## 6. 优先阅读的文件清单

| 文件 | 理由 |
|------|------|
| `README.md` | 项目的定位、安装、基本用法 |
| `package.json` | 依赖关系、scripts、monorepo 结构 |
| `CONTEXT.md` / `ARCHITECTURE.md` | 项目设计和架构说明（如果存在） |
| `CONTRIBUTING.md` | 开发环境搭建、调试方法 |
| `src/index.ts` | 入口文件，最重要的起点 |
| `tsconfig.json` | TypeScript 编译配置 |
| `.github/workflows/` | CI/CD 流程 |
| 框架配置（`next.config.ts` / `vite.config.ts` 等） | 了解构建工具链 |

---

## 7. 一个实际案例：以本项目为例快速上手指南

> 完整架构和启动手册详见 [STARTUP_GUIDE.md](./STARTUP_GUIDE.md)。

### 7.1 第一印象

**OpenCode** 是一个 AI Coding Agent 运行平台（类似 Claude Code / Cursor），基于 TypeScript + Effect v4 + SolidJS + Bun。

```
代码量：34+ npm packages / 2000+ 文件
运行时：Bun（主力）、Cloudflare Workers（云服务）、Electron（桌面）
```

### 7.2 快速上手检查清单

拿到项目后按此顺序阅读：

```
① README.md + package.json  → 它是什么？技术栈？
② packages/*/package.json  → 包依赖方向，画分层架构
③ src/index.ts              → 入口文件，看 yargs 注册了哪些命令
④ 核心抽象（Effect）        → yield* / Layer / pipe 的含义
⑤ 追踪一个请求              → 用户 prompt → Server → LLM → 工具 → 回显
```

### 7.3 分层架构速览

项目 34+ 个包分为 8 层，**上层依赖下层**：

| 层 | 关键包 | 职责 |
|----|--------|------|
| 0 基础 | `schema`, `protocol` | 领域模型、数据类型、API 定义 |
| 1 核心 | `core`, `llm` | 会话、工具、权限、PTY、LLM Provider |
| 2 服务 | `opencode`, `server` | CLI 入口、HTTP 服务、路由中间件 |
| 3 UI | `tui`, `app`, `ui` | 终端 UI、Web 应用、共享组件 |
| 4 壳 | `desktop`, `web` | Electron 桌面、文档站 |
| 5 云 | `console`, `stats` | SaaS 管理面板、统计 |
| 6 SDK | `sdk/js`, `plugin` | JS SDK、插件扩展 |
| 7 基础 | `infra/`, `nix/` | SST/AWS 基础设施、Nix 构建 |

### 7.4 关键判断清单

| 问题 | 如何判断 |
|------|----------|
| 这是什么项目？ | `README.md` + `package.json#description` + `package.json#bin` |
| 技术栈是什么？ | `devDependencies` 扫一圈（Effect / SolidJS / Drizzle） |
| 依赖方向？ | 对比不同包的 `dependencies`，上层包依赖下层包 |
| 核心抽象？ | 看入口文件 import 了什么（`effect` / `yargs`） |
| 数据流？ | 从入口文件开始追踪一个完整请求 |
| 运行环境？ | `bun`（CLI）、`cloudflare workers`（云）、`electron`（桌面） |

---

## 9. 有经验开发者的实操路线（针对本项目）

> 以下内容假设你已经熟练阅读代码，重点放在**最小认知负荷下建立准确心智模型**。

### 9.1 第一小时：建立心智模型

#### 15 分钟：Effect 速记表

本项目基于 Effect v4。这不是装饰性框架，是所有代码的骨架。只需记 5 个模式：

| 你熟悉的概念 | Effect 等价写法 | 说明 |
|------------|----------------|------|
| `await fn()` | `yield* fn()` | 99% 的 yield* 可以理解为 await |
| `async function f()` | `Effect.fn("f")(function*() { })` | 定义 Effect 函数 |
| `const svc = new Service(deps)` | `const svc = yield* Service` | Effect 服务定位器（自带 DI） |
| `app.use(middleware)` | `pipe(effect, Effect.provide(Layer))` | 注入依赖，类似中间件栈 |
| `Promise.all([a, b])` | `Effect.all([a, b])` | 并发执行 |

**不要深入学 Effect**。先记住这 5 个模式，能覆盖 90% 的代码阅读。卡住时再搜具体 Effect API。

#### 20 分钟：理解分层契约

整个 monorepo 只有一个硬规则：

> **上层包可以 import 下层包，下层包绝不 import 上层包。**

把这条规则当作代码导航的指南针 —— 看见一个 import，你就能判断哪边是"上游"（被依赖方，更底层），哪边是"下游"（依赖方，更上层）。

#### 25 分钟：用 IDE 跟一条数据流

打开 `STARTUP_GUIDE.md` §7.5 选 **TUI 模式数据流**，在 IDE 里按链路逐个文件跳转：

```
opencode/src/index.ts
  → cli/cmd/run.ts
    → run/runtime.boot.ts
      → tool/registry.ts
        → session/llm.ts
```

**不读实现**，只读函数签名和关键类型。目标是画出一条端到端的请求路径，而不是理解每个环节的细节。

---

### 9.2 第二小时：聚焦核心模块

按这个优先级阅读，越靠前的越值得细读：

#### 1. `packages/opencode/src/tool/` — Agent 的能力边界

所有工具注册在 `tool/registry.ts`，每个工具定义了 LLM 能做什么。

| 文件 | 为什么先读 |
|------|-----------|
| `tool/registry.ts` | 工具注册入口，看到全部工具清单 |
| `tool/read.ts` | 最简单最常用的工具，理解"工具契约"的写法 |
| `tool/edit.ts` + `tool/apply_patch.ts` | 核心价值：AI 改代码的能力 |
| `tool/shell/` | 权限控制机制：Agent 如何被约束 |
| `tool/task.ts` | 子 Agent 系统：多 Agent 并行的实现 |

**这个目录定义了 Agent 能力的边界。** 理解这里，你就理解了项目的核心价值。

#### 2. `packages/opencode/src/session/` — LLM 交互循环

| 文件 | 理解重点 |
|------|----------|
| `session/llm.ts` | 主循环：请求 → 响应 → 工具调用 → 继续 |
| `session/prompt/` | 系统提示词，**决定了 Agent 的行为风格** |
| `session/run-state.ts` | 会话生命周期和并发控制 |
| `session/session.ts` | 会话模型（含子会话树） |

#### 3. `packages/llm/src/` — 多模型支持（可选）

关注 `provider.ts` + `route/` 理解路由机制。不需要细看每个 provider 的实现。

#### 4. 验证性实操

| 方向 | 做法 |
|-----|------|
| 加一个工具 | `tool/` 下新建 → 注册到 `registry.ts` → 重启验证 |
| 追踪一个会话请求 | 从 TUI 输入 prompt → 断点停在 `session/llm.ts` |
| 改 Agent 行为 | 改 `session/prompt/default.txt` 里的提示词 |

---

### 9.3 避坑清单

| ❌ 别做的事 | 原因 |
|-----------|------|
| 通读整个 monorepo | 34 个包 2000+ 文件，读不完也没必要 |
| 深学 Effect | 记住上表 5 个模式就够了，深入是改核心框架时才需要的 |
| 读 `packages/core/` 内部实现 | 那是框架层，90% 的开发不需要改它 |
| 从 `packages/console/` 开始 | 那是 SaaS 控制台，和 Agent 核心能力无关 |
| 埋头看代码不动手 | 读 10 个文件不如改一行代码跑一次 |

| ✅ 该做的事 | 原因 |
|-----------|------|
| 按数据流跳转读代码 | 理解代码如何流动，比理解静态结构重要 |
| 先读 prompt 文件 | 提示词比代码更直接影响 Agent 行为 |
| 理解工具契约 | LLM 看到什么 → 能做什么 → 结果如何返回 |
| 改一行就跑 | 小改动验证理解，不要只看不碰 |
| 遇到 Effect 语法卡住时再搜 | 不要提前学习，按需查表 |
