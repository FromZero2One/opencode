# LLM 调用链路 — 源码学习笔记

> 探索 opencode 核心层中，大模型（LLM）是如何被调用的。
> 从 Session 入口到最终发出 HTTP 请求给 OpenAI/Anthropic 等 Provider 的完整链路。

---

## 概览：两套并行路径

| 路径 | 位置 | 核心依赖 | 状态 |
|------|------|----------|------|
| **V1（AI SDK）** | `packages/opencode/src/session/` | Vercel AI SDK `streamText()` | 遗留，仍在使用 |
| **V2（原生）** | `packages/core/src/session/runner/` | `@opencode-ai/llm` 原生协议 | 新版，逐步迁移中 |

两条路径最终都连接到相同的底层 Provider API（OpenAI、Anthropic 等），区别在于中间层。

---

## V1 路径（AI SDK）

### 入口：SessionPrompt.prompt()

`packages/opencode/src/session/prompt.ts:1052`

用户发送消息的公共入口。创建用户消息后调用 `loop()`。

```
SessionPrompt.prompt()
  └─ createMessage()       // 创建用户消息，写入 DB
  └─ loop()                // 主处理循环
      └─ runLoop()
          └─ processor.create({ assistantMessage, sessionID, model })
          └─ handle.process(streamInput)
```

### 核心处理：SessionProcessor

`packages/opencode/src/session/processor.ts`

`process()` 方法是核心（第 627 行）：

```typescript
// processor.ts:640
const stream = llm.stream(streamInput)
```

Stream 消费部分（642-645 行）通过 `Stream.tap(handleEvent)` 处理每个 LLM Event（文本增量、工具调用、推理过程等），并持久化到 Session DB。

重试策略在 `SessionRetry.policy()`（660-674 行）中定义。

### LLM 服务层

`packages/opencode/src/session/llm.ts`

`llm.stream(input)` 方法（第 357 行）做了三件事：

```
stream(input)
  ├─ 创建 AbortController
  └─ 调用 run(input)
      └─  Provider.getLanguage(model)    // 第 95 行
      └─  LLMRequestPrep.prepare(...)    // 第 106 行
      ├─ [实验性] LLMNativeRuntime      // 第 226 行
      │    如果 flags.experimentalNativeLlm 为 true，尝试原生路径
      └─ [默认] streamText()             // 第 280 行，Vercel AI SDK
```

**默认路径**（第 276-353 行）：

```typescript
streamText({
  model: wrapLanguageModel({ model: language, middleware: [...] }),
  messages: prepared.messages,
  tools: prepared.tools,
  temperature: prepared.params.temperature,
  // ...
  abortSignal: input.abort,
})
```

返回的 `streamText().fullStream` 异步迭代器经过 `LLMAISDK.toLLMEvents()` 适配后变成 `LLMEvent` 流。

### Provider 模型解析

`packages/opencode/src/provider/provider.ts`

`getLanguage(model)`（第 1830 行）获取 `LanguageModelV3` 实例：

```
getLanguage(model)
  └─ resolveSDK(model)                        // 第 1839 行
  │     ├─ 合并 provider 配置（baseURL, API key, custom fetch）
  │     ├─ 检查 BUNDLED_PROVIDERS 映射        // 第 1765 行
  │     │   内置 @ai-sdk/openai, @ai-sdk/anthropic 等
  │     ├─ 回退到 Npm.add() + 动态 import()
  │     └─ 调用工厂函数 createOpenAI({...})
  └─ sdk.languageModel(model.api.id)          // 第 1850 行
```

`BUNDLED_PROVIDERS` 映射（第 107 行附近）定义了哪些 Provider 包可以直接加载，无需额外 npm 安装。

### 请求构建

`packages/opencode/src/session/llm/request.ts`

`LLMRequestPrep.prepare()`（第 56 行）构建最终请求：

- **System Prompt**（58-78 行）：合并 agent prompt、系统上下文、用户 system messages
- **Messages**（101-112 行）：将 system messages 拼入 messages 数组
- **参数**（114-132 行）：temperature, topP, topK, maxOutputTokens — 从模型能力、agent 配置、provider 选项中合并
- **Tools**（148 行）：`resolveTools()` 过滤基于权限的工具
- **Headers**（134-146、187-204 行）：session affinity、user-agent、插件扩展头

### AI SDK 事件适配

`packages/opencode/src/session/llm/ai-sdk.ts`

`toLLMEvents(state, event)`（第 76 行）将 AI SDK 的 `fullStream` 事件类型转成 `LLMEvent`：

| AI SDK 事件 | → | LLMEvent |
|---|---|---|
| `start-step` | → | `LLMEvent.stepStart` |
| `text-start/delta/end` | → | `LLMEvent.textStart/Delta/End` |
| `reasoning-start/delta/end` | → | `LLMEvent.reasoningStart/Delta/End` |
| `tool-call` | → | `LLMEvent.toolCall` |
| `tool-result` | → | `LLMEvent.toolResult` |
| `step-finish` | → | `LLMEvent.stepFinish`（含 usage 和 finish reason） |
| `finish` | → | `LLMEvent.finish` |
| `error` | → | Effect failure |

---

## V2 路径（原生 @opencode-ai/llm）

### 入口：SessionExecution

`packages/core/src/session/execution.ts`

定义 `Interface` — `resume()`, `wake()`, `interrupt()`, `active()`。

`packages/core/src/session/execution/local.ts:17`：

```typescript
const drain = (sessionID) =>
  SessionRunner.Service.use((runner) => runner.run({ sessionID, force }))
```

通过 `SessionRunCoordinator`（`packages/core/src/session/run-coordinator.ts`）协调并发：
- `run(key)` — 启动或加入活跃 session
- `wake(key)` — 调度合并后的后续执行
- `interrupt(key)` — 停止活跃执行

### SessionRunner.run()

`packages/core/src/session/runner/llm.ts:383`

主 drain 循环：

```
run(input)
  ├─ 检查待处理的 steer / queue 输入
  └─ 循环调用 runTurn()                       // 第 393 行
      └─ runTurnAttempt()                     // 第 173 行
```

### runTurnAttempt() — 单次 Provider 回合

`packages/core/src/session/runner/llm.ts:173`

核心步骤：

```
runTurnAttempt()
  ├─ getSession(sessionID)                    // 第 179 行 - 加载 Session
  ├─ agents.select(session.agent)             // 第 182 行 - 选择 Agent
  ├─ SessionContextEpoch.initialize()         // 第 183 行 - 初始化上下文
  ├─ models.resolve(session)                  // 第 199 行 - 解析模型
  ├─ SessionHistory.entriesForRunner()        // 第 200 行 - 加载历史消息
  ├─ tools.materialize()                      // 第 203 行 - 物化工具
  ├─ LLM.request({ ... })                     // 第 205 行 - 构建 LLM 请求
  └─ llm.stream(request)                      // 第 232 行 - 调用 LLM
```

### 模型解析（V2）

`packages/core/src/session/runner/model.ts:188`

`SessionRunnerModel.resolve(session)`：

```
resolve(session)
  ├─ 从 catalog 获取默认模型                    // 第 190 行
  ├─ 匹配可用 catalog 模型                      // 第 191-197 行
  ├─ 获取 provider 和 credential               // 第 204-211 行
  └─ resolve(session, selected, credential)     // 第 172 行
      ├─ withVariant() — 应用 variant 覆盖      // 第 104-126 行
      └─ fromCatalogModel()                     // 第 131-170 行
          ├─ @ai-sdk/openai → OpenAIResponses.route
          ├─ @ai-sdk/anthropic → AnthropicMessages.route
          └─ @ai-sdk/openai-compatible → OpenAICompatibleChat.route
```

返回 `@opencode-ai/llm` 的 `Model` 对象。

### 消息转换

`packages/core/src/session/runner/to-llm-message.ts:170`

`toLLMMessages(messages, model)` 将 V2 Session 消息转为 `@opencode-ai/llm` 的 `Message`：

| Session 消息类型 | → | 映射方式 |
|---|---|---|
| `user` | → | 文本 + media 文件 |
| `assistant` | → | 扁平化文本、推理、工具调用、工具结果 |
| `system` | → | `Message.system()` |
| `shell` | → | 用户消息 + shell 命令和输出 |
| `compaction` | → | 用户消息 + 对话摘要检查点 |
| `synthetic` | → | 用户消息 + 文本 |
| `agent-switched` / `model-switched` | → | 跳过（空） |

### 最终调用

`packages/core/src/session/runner/llm.ts:232`

```typescript
const providerStream = llm.stream(request).pipe(
  Stream.runForEach((event) => ...)
)
```

`llm` 是 `LLMClient.Service`（来自 `@opencode-ai/llm/route`），通过 `RequestExecutor` 和 `FetchHttpClient` 发出实际 HTTP 请求（`packages/core/src/effect/app-node-platform.ts:16`）。

---

## 核心穿插层：AISDK.Service

`packages/core/src/aisdk.ts`

这层是 V1 和 V2 路径共享的底层 SDK 管理：

```
AISDK.Service
  ├─ language(model)           // 获取 LanguageModelV3
  │    ├─ prepareOptions()     // 合并模型配置、自定义 fetch、超时
  │    ├─ runSDK()             // 触发插件 SDK hook，拿到 SDK
  │    └─ runLanguage()        // 触发插件 language hook，拿到 LanguageModelV3
  ├─ hook.sdk(callback)        // 插件注册：SDK 创建时回调
  └─ hook.language(callback)   // 插件注册：语言模型实例化时回调
```

关键设计：

- **缓存**（第 154-155 行）：`languages` 和 `sdks` 两个 Map 缓存已初始化的 SDK 和模型实例，避免重复加载
- **插件 Hook**（第 186-196 行）：让外部插件可以介入 SDK 创建和语言模型实例化过程
- **自定义 fetch**（第 85-119 行）：注入超时控制、chunkTimeout、请求体清理等中间件

### prepareOptions() 详解

`packages/core/src/aisdk.ts:74`

```
prepareOptions(model, pkg)
  ├─ name: model.providerID
  ├─ baseURL: model.api.url           // 仅 aisdk 类型
  ├─ settings: model.api.settings     // 仅 aisdk 类型
  └─ 自定义 fetch wrapper：
       ├─ 合并 signal（abortSignal + chunkTimeout + timeout）
       ├─ 清理 OpenAI/Azure/Bedrock 请求体中的 input.id
       └─ wrapSSE() — SSE chunk 超时保护
```

---

## 实验性路径：LLMNativeRuntime

`packages/opencode/src/session/llm/native-runtime.ts`

当启用了 `experimentalNativeLlm` flag 时尝试。仅在以下 Provider 中支持：
- `openai` + `@ai-sdk/openai`
- `anthropic` + `@ai-sdk/anthropic`
- `opencode*` + `@ai-sdk/openai-compatible`

```
LLMNativeRuntime.stream()
  ├─ statusWithFetch() — 检查是否支持
  ├─ LLMNative.request() — 构建 @opencode-ai/llm 格式请求
  │    见 native-request.ts:181
  │    └─ model() — 路由到正确的 Provider 配置
  │        支持：OpenAI, Anthropic, Azure, Google, Bedrock, OpenRouter
  └─ llmClient.stream() — 调用 @opencode-ai/llm 原生流
```

---

## 关键模块索引

| 文件 | 作用 |
|------|------|
| `packages/opencode/src/session/prompt.ts` | V1 入口，SessionPrompt.prompt() → loop() |
| `packages/opencode/src/session/processor.ts` | V1 核心处理，stream 消费与持久化 |
| `packages/opencode/src/session/llm.ts` | V1 LLM 服务层，stream() → getLanguage + streamText |
| `packages/opencode/src/session/llm/request.ts` | V1 请求构建（prompt、messages、tools、参数） |
| `packages/opencode/src/session/llm/ai-sdk.ts` | V1 AI SDK 事件 → LLMEvent 适配器 |
| `packages/opencode/src/session/llm/native-runtime.ts` | V1 实验性原生运行时 |
| `packages/opencode/src/session/llm/native-request.ts` | V1 原生请求构建与 Provider 路由 |
| `packages/opencode/src/provider/provider.ts` | V1 Provider 工厂，resolveSDK + getLanguage |
| `packages/core/src/aisdk.ts` | AISDK.Service，SDK 初始化缓存与插件 hook |
| `packages/core/src/provider.ts` | Provider 类型定义（从 schema 导出） |
| `packages/core/src/model.ts` | Model 类型定义（从 schema 导出） |
| `packages/core/src/session/execution.ts` | V2 入口，Interface 定义 |
| `packages/core/src/session/execution/local.ts` | V2 本地执行，drain → SessionRunner |
| `packages/core/src/session/run-coordinator.ts` | V2 并发协调器（run/wake/interrupt） |
| `packages/core/src/session/runner/llm.ts` | V2 核心循环，runTurnAttempt() |
| `packages/core/src/session/runner/model.ts` | V2 模型解析，fromCatalogModel() |
| `packages/core/src/session/runner/to-llm-message.ts` | V2 消息转换 |

---

## 数据流全景图

```
用户输入
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                   V1 路径 (AI SDK)                          │
│                                                             │
│  SessionPrompt.prompt()                                     │
│    └─ runLoop() → processor.create() → process()            │
│         └─ llm.stream()                                     │
│              ├─ Provider.getLanguage()                       │
│              │    └─ resolveSDK() → sdk.languageModel()      │
│              │         └─ @ai-sdk/openai / @ai-sdk/anthropic │
│              └─ streamText({ model, messages, tools })       │
│                   └─ fullStream (AI SDK)                     │
│                        └─ toLLMEvents() → LLMEvent 流       │
│                                                             │
│    [实验性] LLMNativeRuntime                                │
│         └─ llmClient.stream() → @opencode-ai/llm             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   V2 路径 (原生)                             │
│                                                             │
│  SessionExecution.resume()                                   │
│    └─ SessionRunner.run()                                    │
│         └─ runTurnAttempt()                                  │
│              ├─ models.resolve() → @opencode-ai/llm Model    │
│              ├─ toLLMMessages() → @opencode-ai/llm Message   │
│              ├─ LLM.request({ model, system, messages })     │
│              └─ llm.stream(request)                          │
│                   └─ RequestExecutor → HTTP 请求             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
              OpenAI / Anthropic / Azure / 其他 Provider API
```

---

## 学习要点

1. **双层架构**：`packages/core` 定义核心抽象和接口，`packages/opencode` 实现具体编排。这种分层让 Provider 无关的逻辑和具体调用解耦。

2. **两代并存**：V1（AI SDK）和 V2（原生 `@opencode-ai/llm`）并行。V2 正在逐步取代 V1，目前通过 `experimentalNativeLlm` flag 控制灰度。

3. **插件系统贯穿**：`AISDK.hook.sdk` 和 `AISDK.hook.language` 让插件可以在 SDK 初始化和模型实例化时介入，实现中间件式的扩展。

4. **缓存策略**：SDK 实例和语言模型都做了缓存（`Map<string, LanguageModelV3>`），避免重复初始化和动态 import。

5. **超时控制**：自定义 fetch 封装了复杂的超时机制 — abortSignal（来自外层）、chunkTimeout（SSE 单块超时）、timeout（总超时），三层叠加通过 `AbortSignal.any()` 合并。

---

# 学习路径

> 以下方案由 10 年+系统架构师提供，按开发者资历分两套。
>
> 核心原则：**不要在理解问题域之前深入实现细节。**

---

## 初级程序员学习路径

预计总时间 **20-30 小时**。适合 1-3 年经验，对 Effect 框架不熟悉，需要手把手引导。

### 第一阶段：理解问题域（不动代码）

搞清楚这个项目**解决什么问题**，建立心智模型。

| 步骤 | 做什么 | 理由 |
|---|---|---|
| 1.1 | 读 `README.md` + `CONTEXT.md` 前 50 行 | 理解项目定位：AI 编码代理，不是普通聊天 |
| 1.2 | 用一次产品（`bun dev` 跑起来，问个简单问题） | 建立直觉：session、agent 切换、工具调用 |
| 1.3 | 读根目录 `AGENTS.md` 的架构分层说明 | 理解分层方向：Schema → Core → Protocol → Server |

**产出**：能用自己的话解释这个项目做什么，以及几层之间如何依赖。

---

### 第二阶段：Schema 核心类型（5 个文件）

从依赖树的叶子节点开始，只读最核心的类型定义。

```
packages/schema/src/
  ├─ provider.ts          ← Provider 是什么（ID / Api / Info / Request）
  ├─ model.ts             ← Model 是什么（Info / Capabilities / Cost / Ref）
  ├─ session.ts           ← Session 核心结构
  ├─ session-message.ts   ← 消息类型体系（user / assistant / tool / system）
  └─ permission.ts        ← 权限模型
```

**不要全读 61 个文件**，其他类型按需查阅。

**产出**：能画出 Session、Message、Provider、Model 的关系图，并在后续阅读中快速定位类型定义。

---

### 第三阶段：Effect 框架基础

这个项目重度使用 Effect v4 beta。不需要精通，但要能流畅阅读。

必须掌握的 6 个概念：

| 概念 | 典型用法 | 在哪出现 |
|---|---|---|
| `Effect.gen` | `Effect.gen(function* () { const x = yield* foo() })` | 几乎每个文件 |
| `Effect.fn` | `Effect.fn("Name")(function* (input) { ... })` | 命名 Effect，可追踪 |
| `Layer` + `Context.Service` | `class Service extends Context.Service<...>() {}` | DI 容器，所有服务的声明方式 |
| `Stream` | `Stream.tap(handler).pipe(Stream.runDrain)` | processor.ts 消费 LLM stream |
| `Scope` | `Effect.acquireRelease` / `Scope.addFinalizer` | 资源生命周期管理 |
| `Effect.cached` | 单次计算多消费者共享 | AISDK 的 language 缓存模式 |

**不必深究**：`Schema.Class`、`Effect.Schedule`、`Fiber` 等可以遇到时再查。

**产出**：能读懂 `yield*` 串行调用链、区分 `Effect` 和普通函数、理解 `Stream` 的基本消费模式。

---

### 第四阶段：追踪一条请求（三条短路径）

不要一上来读 `prompt.ts` 的 1631 行。把请求拆成 **3 条独立的短路径**，每条只读 1-2 个文件，关注输入输出。

#### 路径 A — 请求构建（最窄，纯数据变换）

```
阅读顺序（2 个文件）:
  1. session/system.ts (145 行)
     → 理解 system prompt 的 3 个组成部分：环境信息 + skills + MCP 指令
     → 注意不同模型走不同 prompt 模板（anthropic.txt vs gpt.txt 等）

  2. session/llm/request.ts (226 行)
     → prepare() 的输入输出：StreamInput → Prepared
     → 关注三个合并点：
        ① system prompt 拼接：agent.prompt + input.system + user.system
        ② 参数合并：模型能力 → agent 配置 → variant 覆盖
        ③ 工具过滤：权限系统如何决定工具可用性
```

**产出**：能解释从原始输入到最终 LLM 请求经过哪些转换层，每层做了什么。

#### 路径 A+ — 工具系统

```
阅读顺序（2 个文件）:
  1. session/tools.ts
     → SessionTools.resolve() 如何收集和过滤工具

  2. prompt.ts 中的工具解析段落 (1226-1241 行)
     → 工具如何在循环中被解析、注册、权限过滤
```

**产出**：理解工具注册、权限过滤、注入到 LLM 的完整链路。

#### 路径 B — 流处理（纯输入输出）

```
阅读顺序（2 个文件）:
  1. session/llm.ts (404 行)
     → 重点在 stream() 函数 (357-381 行)
     → run() 函数 (85-354 行)，关注：
        ① 运行时选型门控 (224-269 行)：native vs AI SDK
        ② 默认 AI SDK 路径 (276-353 行)：streamText() 调用

  2. session/processor.ts (718 行)
     → handleEvent (278 行起) 的 switch-case 结构
     → process() (627-683 行)：llm.stream() → 消费 → 返回 result
     → 重试策略 SessionRetry.policy() (660-674 行)
```

**产出**：能追踪一个 LLM Event 从 provider 到数据库持久化的完整路径。

#### 路径 C — 循环控制

```
阅读顺序（1 个文件）:
  session/prompt.ts:1081-1340
    仅关注 runLoop 函数的控制流：
      → 1088-1130: 终止条件判断（hasToolCalls + finish reason）
      → 1132-1133: step 计数和 maxSteps
      → 1141-1168: subtask / compaction 旁路分支
      → 1272-1330: 调用 handle.process() 后的决策（break / compact / continue）
```

**产出**：能解释 runLoop 在什么条件下继续、什么条件下停止，以及为什么需要 `hasToolCalls` 和 `lastAssistant.finish` 两个条件同时判断。

---

### 第五阶段：理解核心设计模式（可选）

当能走通一条请求后，回头看架构模式：

| 模式 | 在哪体现 |
|---|---|
| **插件系统** | `AISDK.hook.sdk/language` + `plugin.trigger()` |
| **分层解耦** | `core/aisdk.ts` 定义抽象，`opencode/provider/provider.ts` 实现 |
| **两代并存** | V1 (AI SDK) 和 V2 (native) 并行，通过 flag 灰度 |
| **事件驱动** | `LLMEvent` 统一事件模型，processor 消费 |
| **重试策略** | `SessionRetry.policy()` 可配置、可扩展 |

---

### 初期不要碰的

| 避开 | 理由 |
|---|---|
| `packages/core/src/session/runner/` (V2) | 更抽象、更多 Effect 高级用法、开发中的代码 |
| `packages/opencode/src/provider/provider.ts` 全量 | 1800+ 行，包含大量供应商特定逻辑 |
| `packages/core/src/config/` | 配置框架，与核心调用链路无关 |
| Compaction / Context Epoch | 高级优化，不是核心路径 |
| `@opencode-ai/llm` 外部依赖 | 不在仓库内，只有类型引用 |

---

## 中级程序员学习路径

预计总时间 **4-6 小时**。适合 3-5 年经验，能独立阅读陌生代码，关注架构决策和可修改性。

### 第 1 小时：架构图建立

直接读 3 个边界文档，跳过所有源码：

```
1. 根目录 AGENTS.md                  ← 分层方向、代码风格、commit 规范
2. packages/schema/AGENTS.md         ← Schema 边界：什么该放这里、什么不该
3. packages/opencode/src/session/llm/AGENTS.md  ← 运行时选型的完整架构图（推荐先读这个）
```

**看完应该能**：画出分层图，并在 30 秒内回答"新加一个 provider 要改哪些文件"。

---

### 第 2 小时：核心抽象层

快速过 `packages/core/src/` 的 3 个关键文件，关注**接口设计**而不是实现细节：

```
aisdk.ts      ← AISDK.Service 的契约
                 为什么 language() 和 hook 要分两个方法？
                 缓存策略为什么用 Map？为什么插件用回调注册而不是 emit/on？

provider.ts  ← 注意它只是 schema 的 re-export，没有实现本体
model.ts     ← 同上，理解 Model 和 Provider 为何分离
```

**关键思考题**：为什么 `AISDK.language()` 要返回 `LanguageModelV3`，而不是直接返回 `streamText` 的结果？

---

### 第 3 小时：追踪一条请求（关注"为什么"）

读 `packages/opencode/src/session/` 的 4 个文件，但关注设计决策：

```
llm.ts        ← 224-269 行运行时选型门控
                 为什么 native vs AI SDK 的切换点放在这里？为什么不用策略模式？

llm/request.ts ← 56-79 行 system prompt 拼接策略
                  为什么要分 agent.prompt + input.system + user.system 三层？
                  plugin.trigger("experimental.chat.system.transform") 在这里做什么？

processor.ts  ← 627-683 行 process() + 重试
                 为什么重试是 Effect.retry 而不是 try-catch？
                 为什么 handleEvent 是闭包内函数而不是 class 方法？

prompt.ts     ← 1088-1130 行循环终止条件
                 为什么需要 hasToolCalls 和 lastAssistant.finish 两个条件？
                 为什么 orphanedInterruptedTool 要特殊处理？
```

---

### 第 4 小时：可修改性分析

作为中级开发者，最关心的是：**我要改一个东西，从哪入手？**

| 场景 | 查找路径 |
|---|---|
| 加一个新 Provider | `packages/opencode/src/provider/provider.ts` → resolveSDK() + BUNDLED_PROVIDERS |
| 改 System Prompt 内容 | `packages/opencode/src/session/system.ts` → environment() / skills() / mcp() |
| 改循环 break 条件 | `packages/opencode/src/session/prompt.ts:runLoop` → 1106-1130 行 |
| 加一个新的 LLM Event 类型 | `packages/opencode/src/session/llm/ai-sdk.ts:toLLMEvents` + schema 类型 |
| 改重试策略 | `packages/opencode/src/session/retry.ts` + processor.ts:660-674 |
| 加插件 hook | `packages/opencode/src/session/llm/request.ts` → plugin.trigger() chat.params / headers |

---

### 第 5 小时（可选）：V2 对比

如果对架构演进感兴趣：

```
packages/core/src/session/runner/llm.ts:383-406
  → 对比 V1 runLoop 的差异

  V1: while(true) + 内部手动 break/continue
  V2: 双层 while:
       外层 while(shouldRun)  — 处理 steer / queue 输入
       内层 while(needsContinuation) — 工具调用循环

  为什么 V2 要拆两层？
  steer 和 queue 的语义分别对应什么场景？
```

---

## 两套方案的差异总结

| 维度 | 初级方案 | 中级方案 |
|---|---|---|
| 总时间 | 20-30 小时 | 4-6 小时 |
| Schema | 读 5 个核心文件 | 从 import 推断即可 |
| Effect | 6 个概念逐个学习 | 边读边学，不单独教学 |
| 阅读方式 | 精确到行号、分路径 | 给文件 + 设计问题，自行定位 |
| 验证 | 每阶段有具体产出要求 | 不需要，自己会验证 |
| 关注点 | "输入输出是什么" | "为什么这样设计" |
| 工具系统 | 单独一条路径 | 融入请求构建理解 |
| 最终产出 | 能独立走通请求链路 | 能回答修改场景的切入路径 |