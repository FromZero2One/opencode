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

## 7. 一个实际案例：本项目的启动入口

```
bun dev
  └─ package.json "scripts.dev"
       └─ packages/opencode/src/index.ts    ← yargs CLI 入口
            ├─ .command(TuiThreadCommand)   ← bun dev → TUI
            ├─ .command(ServeCommand)       ← bun dev serve → API server
            └─ .command(WebCommand)         ← bun dev web → web UI
```

```
bun dev serve
  └─ index.ts → ServeCommand
       └─ packages/opencode/src/cli/cmd/serve.ts
            └─ packages/opencode/src/server/server.ts → Server.listen()
                 └─ Hono HTTP 服务监听端口
```

---

## 8. 注意

### 入口不总是 package.json scripts

| 类型 | 入口机制 |
|------|----------|
| Node.js / Bun | `package.json scripts` |
| Deno | `deno.json` / `deno task` |
| Vite 前端 | `index.html` → `<script>` |
| Next.js / Nuxt | 框架约定目录（`app/`, `pages/`） |
| CLI 工具 | `package.json` `"bin"` 字段 |
| VS Code 扩展 | `package.json` `"main"` / `"browser"` 字段 |
| Web Worker | 由主线程 `new Worker(...)` 加载 |

### 开发入口 vs 发布入口

同一个项目，开发时和发布后的入口可能不同：

```json
// 开发时走 scripts
"scripts": { "dev": "bun src/index.ts" }

// 发布后走 bin（直接可执行命令）
"bin": { "opencode": "./bin/opencode" }
```
