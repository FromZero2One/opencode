# OpenCode 架构概览

本文档对 OpenCode（V2）的系统架构、核心模块职责和关键设计决策进行梳理。内容主要来源于仓库中的 `specs/v2/*` 规格说明、根目录及各包 `AGENTS.md`，以及核心包的源码结构。

> **注意**：本文档是语义概览，不是 API 参考，也不是待办事项列表。如有与代码不一致之处，以代码和 `specs/v2/*` 为准。

---

## 一、项目定位

OpenCode 是一个开源 AI 编程代理，可作为**终端 TUI、桌面应用、IDE 扩展**或**CLI** 使用。核心能力包括：

- 在终端里与 LLM 对话，直接读写项目文件、运行 shell 命令
- 内置 Build / Plan 两类主代理，以及 General / Explore 等子代理（支持 `@` 提及调用）
- 支持 75+ LLM 提供商（Anthropic、OpenAI、Gemini、Bedrock、本地模型等）
- 通过 **MCP 服务器**、**自定义工具**、**插件**、**技能（SKILL.md）**、**自定义命令** 进行深度扩展
- 提供多层配置、细粒度权限、上下文压缩、会话快照与撤销重做

官网：<https://opencode.ai>  
V2 文档：<https://opencode.ai/v2/docs/>

---

## 二、分层架构与依赖方向

OpenCode 严格遵循单向依赖，防止循环依赖和职责泄漏：

```
Schema ──► Core ──► Server
   │          │         │
   └────────► Protocol ──┘
                  ▲
               Client（只能依赖 Schema + Protocol，不能依赖 Core/Server）
                  ▲
               SDK（组合 Client、Core、Server）
```

| 层 | 职责 | 所在包 |
|---|---|---|
| **Schema** | 公共域形状、持久事件载荷、类型定义 | `packages/schema` |
| **Core** | 运行时行为、持久化、Session 执行、工具注册、事件投影 | `packages/core` |
| **Protocol** | 公共 HTTP API 端点定义（由 Server `HttpApi` 组装） | `packages/protocol` |
| **Server** | 对外 HTTP API（SSE 事件流、配置、会话等） | `packages/server` |
| **Client** | 客户端运行时，仅依赖 Schema + Protocol | `packages/client` |
| **SDK** | 组合 Client、Core、Server，供上层集成使用 | `packages/sdk` |

**依赖约束（来自根 `AGENTS.md`）**

> Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk` composes Client, Core, and Server.

生成的客户端代码遵循公共 `HttpApi`，不得手动编辑（变更后需运行 `packages/client` 下的 `bun run generate`）。

---

## 三、核心包结构（monorepo）

仓库为 Bun + TypeScript monorepo，主要包包括：

| 包 | 用途 |
|---|---|
| `packages/core` | 运行时核心：Session、执行协调器、持久化、工具注册、插件、权限 |
| `packages/server` | HTTP Server、SSE 事件流、对外 API |
| `packages/protocol` | 公共 API 契约定义 |
| `packages/schema` | 公共域模型与事件 Schema |
| `packages/client` | 客户端运行时（TUI/桌面/CLI 共用） |
| `packages/cli` | 命令行入口，TUI 启动 |
| `packages/tui` | 终端用户界面（基于 OpenTUI / Solid.js） |
| `packages/ui` | UI 组件库 |
| `packages/plugin` | 插件与自定义工具基础设施 |
| `packages/plugin-browser` | 浏览器端插件支持 |
| `packages/sdk` | 组合 SDK |
| `packages/session-ui` | 会话 UI 相关 |
| `packages/gui-extensions` | GUI 扩展 |
| `packages/desktop` | 桌面应用（Electron） |
| `packages/web` / `packages/app` | 网页文档与 Web 应用 |
| `packages/console` | OpenCode Console（云端管理） |
| `packages/effect-drizzle-sqlite` | 数据持久化（Drizzle + SQLite） |
| `packages/util` | 公共工具（文件系统、进程、全局根目录等） |
| `packages/scripts` / `script/` | 构建、发布、类型检查、AST 规则等辅助脚本 |

构建工具链：Bun（包管理器与运行时）、oxlint + ast-grep（ lint 与架构规则）、`@typescript/native`（tsc 类型检查）、Turbo（任务编排）。

---

## 四、Session 执行模型（核心）

这是 OpenCode 最核心的运行时设计，详见 `specs/v2/session.md`。

### 1. Prompt 入场先于执行

`Session.prompt(...)` 先发布一条持久的 `session.inbox.enqueued` 事件，其投影插入一条 `session_inbox` 行，随后才调度 `SessionExecution.wake(sessionID)` 启动执行。在入口项被投递（`session.inbox.delivered`）并插入可见消息之前，它对模型不可见。

- 复用同一个 Session ID 会采纳已有 Session
- 复用同一用户/合成入口项 ID 是幂等的（Session 和类型匹配时，第一次入场胜出）
- `resume: false` 表示仅入场不调度执行（admit-only）

### 2. 执行是进程局部的

`SessionExecution` 是**进程全局、按 Session ID 键控**的。它拥有进程本地的 Session 协调器，仅在排水（drain）开始时通过 `SessionStore` 加载 Session，并通过 `LocationServiceMap.get(session.location)` 发现放置位置。任何层都不直接持有 Session ID。

- 不同 Session 可并发运行
- 中断仅针对活跃的进程本地执行链；对空闲或未在本地拥有的已知 Session 是 no-op；对未知 Session 公共 API 会报错
- 启动恢复会恢复被认领的顶层 Session，带有每次执行的持久尝试计数

### 3. 一步（Step）可能有多次物理尝试

每一步是一个显式 `llm.stream` 调用，从重新加载的历史继续。在每个步骤开始前，Runner 会重载 Session 历史、解析选定 Agent 和模型、准备指令、物料化工具。通用重试、流不完整续接、溢出触发的压缩等可能导致多次物理尝试，但不会重新提升输入。

### 4. 指令是值增量（Value Deltas）

指令同步持久化内容寻址值，并可冻结渲染后的按时间顺序的散文。每个变更的源键映射到 SHA-256 内容哈希。Runner 在每次物理尝试前并发读取所有来源，一次性哈希编码值，并将一个增量与新 Blob 原子性入场。

### 5. 上下文压缩（Compaction）

在每个步骤前，Runner 估算完整模型可见请求相对于所选模型上下文窗口和保留输出空间的大小。启用压缩时，Runner 可存储结构化滚动摘要加最近上下文，而非发送超预算请求。完整转录仍持久化；压缩边界后的模型可见历史包含摘要和保留的最近上下文。

### 6. 持久事件与恢复

- `sessions.log(...)` 验证 Session 并读取持久 Session 事件；`follow: true` 时会先重放再订阅
- 执行提交一个**预写日志（Write-Ahead Claim）** 标记进程本地忙期；成功、失败、用户中断释放该认领；关机中断和进程死亡保留该认领
- 启动恢复从持久投影历史恢复被认领的顶层 Session，并进行失败工具投影的孤儿调和；无法证明中断的外部操作是否已经生效，不提供恰好一次（exactly-once）保证

---

## 五、工具系统

详见 `specs/v2/tools.md`。OpenCode 的工具设计遵循以下核心原则：

### 1. 工具构造

V2 有一个结构化工具值用于本地可执行工具：

```ts
const read = Tool.make({
  description: "Read a file",
  input: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ content: Schema.String }),
  execute: ({ path }, context) => readFile(path, context)
})
```

每个工具响应可携带三个值：
- `output`：经 Schema 验证的瞬态机器值（Code Mode 接收）
- `content`：模型可见值，持久化存储
- `metadata`：可选的紧凑 JSON，供工具特定 UI 使用

### 2. 每次调用有持久身份

每个本地工具调用都携带相同的调用上下文：

```ts
interface Tool.Context {
  sessionID: Session.ID
  agent: Agent.ID
  messageID: SessionMessage.ID
  callID: string
  progress: (update: Progress) => Effect.Effect<void>
}
```

- `messageID` 是包含该调用的助手消息的持久 ID
- `callID` 与持久事件使用的调用标识符相同
- Runner 拥有该关联并将完整上下文提供给注册表，注册表不推断它

### 3. 注册有作用域

工具在注册时命名：

```ts
yield* tools.register({ read, write, grep })
```

- 记录键是作者命名，注册会在派生有效模型面名称前对其进行归一化
- 可复用的工具值没有固有名称
- 同一放置内，最新的活跃注册胜出；关闭注册仅移除该注册；关闭获胜者会显露下一最新活跃注册

### 4. 内置工具与同一契约

内置工具（read/write/grep 等）使用相同的工具 API，同时捕获受信任的 Location 服务。它们负责制定并排序权限请求，`PermissionV2` 评估策略并管理审批；注册表不注入 `assertPermission` 助手。

### 5. 不变法则

- **单次执行**：`Tool.make(config)` 只能执行 `config.execute`
- **编解码边界**：工具观察解码后的输入；Code Mode 观察经过验证的已编码输出；模型内容和元数据来自工具响应
- **规范表达**：一次完成调用恰好存储一个模型表达；一次失败调用恰好存储一个错误加最多一个最终部分快照
- **持久身份**：调用拥有的记录使用 Runner 提供的精确 Session、Agent、助手消息和调用 ID

内置工具包括：`bash`、`read`、`write`、`edit`、`apply_patch`、`grep`、`glob`、`list`、`lsp`（实验性）、`skill`、`todowrite`、`webfetch`、`websearch`、`question`、`task`。

---

## 六、事件流架构（Server → 客户端）

详见 `specs/v2/event-stream-architecture.md`。

### 设计决策

公共 HTTP 事件流使用**一个 Server 作用域的编码 Feed，每条连接一个独立有界队列**。

```text
Core EventV2.listen()
           │ 一个全局订阅
           ▼
Server EventFeed
  公共过滤
  Schema 编码
  JSON 编码
  一次 SSE 帧
           │ 非阻塞提供同一个共享不可变字符串
           ▼
   队列 A   队列 B   队列 C
     │         │         │
   HTTP A    HTTP B    HTTP C
```

### 关键设计点

- **编码一次，多订阅者复用**：Core 拥有一个全局监听器，完成一次公共过滤、Schema 编码和 JSON 序列化，然后将同一个不可变编码字符串非阻塞地提供给所有连接的队列
- **独立溢出**：每条连接有一个容量为 4,096 帧的 `Queue.dropping`。慢订阅者溢出只终止该连接，不影响发布和其他健康连接
- **连接本地帧**：`server.connected`、心跳等与连接相关的帧不消耗队列容量
- **编码失败**：若某个公共事件无法编码，记录其 ID、类型和原因，使所有当前连接队列因 `EncodingError` 失败，跳过该事件，Feed 保持可用

该设计在 50 客户端场景下将编码开销降低约 97.8%（来自规格中的基准测试）。

---

## 七、提供商与集成策略（Policy）

详见 `specs/v2/provider-policy.md`。Policies 控制对命名资源的操作是否允许，由配置文件或连接的 OpenCode Console 提供语句，由终端插件应用。

### 支持的操作

| 动作 | 资源 | 说明 |
|---|---|---|
| `provider.use` | 提供商 ID（如 `openai`、`company-ai`） | 使用某个提供商 |
| `tool.use` | `<权限动作>:<资源>`（如 `shell:sudo *`、`edit:*.env`） | 使用某个工具/权限 |
| `integration.use` | `mcp:<server ID>`、`plugin:<包>`、`hosted:<ID>`、`skill:<ID>` | 使用某个集成 |

### 评估规则

1. 从 `allow` 开始
2. 考虑每个与动作和资源都匹配的语句
3. 每个匹配语句用其 `effect` 替换当前决策
4. **最后匹配的语句决定结果**

跨多个配置文档时，策略按**反向文档顺序**读取，因此用户全局策略可覆盖仓库策略；组织托管策略追加在最后，拥有最终权威。

示例：拒绝所有提供商，仅允许 Anthropic：

```json
{
  "experimental": {
    "policies": [
      { "effect": "deny", "action": "provider.use", "resource": "*" },
      { "effect": "allow", "action": "provider.use", "resource": "anthropic" }
    ]
  }
}
```

---

## 八、扩展性体系

OpenCode 通过以下机制支持扩展，详见各自文档页面：

| 扩展点 | 说明 | 配置位置 |
|---|---|---|
| **MCP 服务器** | 本地或远程 Model Context Protocol 服务器，支持 OAuth 自动处理 | `opencode.json` → `mcp` |
| **自定义工具** | TypeScript/JavaScript 编写，放在 `.opencode/tools/`，内部可调用任意语言脚本 | `.opencode/tools/` |
| **插件（Plugins）** | 通过事件钩子扩展行为（`tool.execute.before/after`、`session.*`、`message.*`、`permission.*` 等），可从 npm 安装或本地加载 | `.opencode/plugins/`、`~/.config/opencode/plugins/` |
| **技能（Skills）** | 可复用的 SKILL.md 指令定义，Agent 通过原生 `skill` 工具发现并按需加载 | `.opencode/skills/`、`~/.config/opencode/skills/`（兼容 Claude 结构） |
| **自定义命令** | markdown 定义的 `/命令`，支持 `$ARGUMENTS`、`!`shell 输出、`@`文件引用 | `.opencode/commands/` |
| **Agent** | 自定义主代理或子代理，可指定模型、提示词、权限、步数、温度等 | `opencode.json` → `agent` 或 `.opencode/agents/*.md` |
| **格式化器** | 内置 Prettier 等，支持自定义格式化命令 | `opencode.json` → `formatter` |
| **LSP 服务器** | 语言服务器集成（如 TypeScript），实验性 | `opencode.json` → `lsp` |

插件事件示例：`command.executed`、`file.edited`、`session.created`、`session.compacted`、`tool.execute.before`、`tui.prompt.append` 等。

---

## 九、配置系统

OpenCode 使用 `opencode.json` / `opencode.jsonc`（支持注释），**多层合并**（非替换）：

1. 远程配置（`.well-known/opencode`，组织默认）
2. 全局配置（`~/.config/opencode/opencode.json`）
3. 自定义配置（`OPENCODE_CONFIG` 环境变量）
4. 项目配置（项目根 `opencode.json`，可提交 Git）
5. `.opencode` 子目录（agents, commands, plugins, skills, tools, themes）
6. 行内配置（`OPENCODE_CONFIG_CONTENT`）
7. 托管/托管偏好（企业 MDM，最高优先级，不可覆盖）

TUI 专用设置使用 `tui.json`（或 `tui.jsonc`），位于 `~/.config/opencode/tui.json` 或项目根。

可配置项涵盖：模型、提供商、权限、MCP、插件、Agent、命令、快照、上下文压缩、格式化器、LSP、观察者、图片附件限制、Shell、主题、按键绑定等。支持 `{env:VAR}` 和 `{file:path}` 变量替换。

---

## 十、开发与贡献要点

### 分支与提交

- 默认分支：`dev`
- 分支名：最多三个单词，用连字符分隔，不带 `feat/`/`fix/` 等前缀（如 `fix-scroll-state`）
- 提交/PR 标题：符合 conventional commit 风格 `type(scope): summary`（`feat`、`fix`、`docs`、`chore`、`refactor`、`test`）

### 检查与类型检查

- `bun run check`：仓库根的完整 lint + 类型检查
- `bun typecheck`：从受影响包目录运行（如 `packages/core`），使用 `bun check`
- CI/发布使用 `bun run typecheck:tsc`（`@typescript/native`），两者有分歧时以 `tsc` 为准
- 测试不可从仓库根运行，需从包目录（如 `packages/core`）运行

### 生成客户端

变更公共 Protocol 或 Server `HttpApi` 后，需从 `packages/client` 运行 `bun run generate`，**不要直接编辑生成的客户端文件**。

---

## 十一、更多文档

- `specs/v2/README.md` — V2 规格总览与权责边界
- `specs/v2/session.md` — Session 合约
- `specs/v2/tools.md` — 工具契约
- `specs/v2/event-stream-architecture.md` — 事件流决策记录
- `specs/v2/provider-policy.md` — 提供商/集成策略
- `specs/v2/catalog-config-plugin-lifecycle.md` — 历史上下文（目录/配置/插件生命周期选型）
- 根 `AGENTS.md` — 贡献者守则、代码风格、TUI 主题 token、Session Core 事件模型
- `packages/schema/AGENTS.md` — Schema 包架构约定
- `packages/core/src/plugin/skill/opencode.md` — OpenCode 核心概念索引（含 client-server 架构说明）
- 线上文档：<https://opencode.ai/v2/docs/>

---

<small>本文档由贡献者基于现有 `specs/v2/*` 与 `AGENTS.md` 整理，如有遗漏或过时，欢迎通过 PR 更新。</small>