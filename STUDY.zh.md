# OpenCode 项目学习笔记

> 主学习文档。每次学习后更新「进度追踪」和「学习日志」两个部分。
>
> 配套文档：
> - [`ARCHITECTURE.zh.md`](./ARCHITECTURE.zh.md) — 技术架构、模块边界、依赖方向
> - [`FEATURES.zh.md`](./FEATURES.zh.md) — 用户可见功能图景
> - [`LEARN.md`](./LEARN.md) — LLM 调用链路专题笔记（早期版本，部分路径已过时：`packages/opencode` 已被删除重构）
> - [`specs/v2/README.md`](./specs/v2/README.md) — V2 官方规格总览

---

## 一、进度追踪

每学完一个模块，把 `[ ]` 改成 `[x]`，并在对应笔记下补充要点。

### 基础认知

- [x] 项目定位与功能图景（参见 `FEATURES.zh.md`）
- [x] 分层架构与依赖方向（参见 `ARCHITECTURE.zh.md`）
- [x] 核心模块清单（monorepo 各包职责）

### 执行流程

- [x] TUI 启动流程（CLI 入口 → 默认命令 → TUI 渲染）
- [x] 服务器端 Prompt 处理（Server handler → Core Session.prompt 入场）
- [x] 执行协调（SessionExecution → SessionRunner → SessionStep）
- [x] 事件回传（Bus → EventFeed → SSE → Client → TUI 渲染）
- [x] LLM 调用链路：模型解析、请求准备、协议编译、Provider 原生 body、流式响应状态机（见第四节；`LEARN.md` 的 V1 路径已过时）

### 待学习清单

- [ ] 工具系统细节：权限检查流程（Permission → assert → allow/ask/deny）
- [ ] 上下文压缩（Compaction）：触发条件、滚动摘要生成（LLM 链路中已确认其接入点：`compaction.compact({ reason: "auto" | "overflow" | "manual" })`）
- [ ] 插件系统：加载顺序、钩子机制、Effect/Promise 双版本
- [ ] MCP 集成：服务器连接、工具注册、OAuth 流程
- [ ] 配置系统：多层合并实现（Config.resolve / precedence）
- [ ] 数据库层：Drizzle + SQLite、投影（projector）、迁移
- [ ] 快照与撤销（Snapshot / Revert）
- [ ] 权限策略（Provider Policy / tool.use）
- [ ] TUI 组件体系：路由、会话标签页、命令面板
- [ ] 测试体系：单元测试组织、TUI 测试、E2E

---

## 二、核心模块速查

| 层 | 包 | 职责 |
|---|---|---|
| 基础 | `packages/schema` | 公共域形状、持久事件载荷 |
| 基础 | `packages/protocol` | 公共 HTTP API 契约（由 Server HttpApi 组装） |
| 基础 | `packages/util` | 文件系统、进程、全局路径等公共工具 |
| 核心 | `packages/core` | Session、执行、持久化、工具注册、权限、插件 |
| 核心 | `packages/effect-drizzle-sqlite` | Drizzle + SQLite 持久化 |
| 服务 | `packages/server` | HTTP API、SSE 事件流（EventFeed） |
| 客户端 | `packages/client` | 生成的客户端（Promise + Effect 两种入口），只依赖 Schema + Protocol |
| 客户端 | `packages/sdk` | 进程内 OpenCode 主机（嵌入式使用） |
| 界面 | `packages/cli` | 命令行入口、TUI 启动、后台服务管理 |
| 界面 | `packages/tui` | 终端 UI（OpenTUI + Solid.js） |
| 界面 | `packages/ui` | 共享 UI 组件库 |
| 界面 | `packages/desktop` | Electron 桌面应用 |
| 扩展 | `packages/plugin` | 插件编写接口（Promise / Effect / RPC / TUI） |
| 扩展 | `packages/plugins` | 内置/社区插件（如 figma） |

依赖方向（单向）：

```
Schema ──► Core ──► Server
   │          │         │
   └────────► Protocol ──┘
                  ▲
               Client（只依赖 Schema + Protocol）
                  ▲
               SDK（组合 Client、Core、Server）
```

---

## 三、执行流程笔记（2026-10-26 梳理）

从 TUI 输入一条消息到 LLM 回复显示回 TUI 的完整闭环。

### 阶段 1：启动（CLI → TUI）

**1. CLI 入口** — `packages/cli/src/index.ts`

```
bun run dev → NodeRuntime.runMain → Runtime.run(Commands, Handlers)
```

- `Handlers.$`（默认命令，直接输入 `opencode` 时）→ `./commands/handlers/default.ts`
- 根命令定义在 `packages/cli/src/commands/commands.ts`（子命令：run / serve / service / auth / mcp / plugin / models / stats / session / debug 等）

**2. 默认命令处理器** — `packages/cli/src/commands/handlers/default.ts`

1. 解析服务器连接（`ServerConnection.resolve`，见 `packages/cli/src/services/server-connection.ts`）：
   - `--server URL`：直连外部服务器（检查版本兼容性）
   - `--standalone` 或服务被禁用：启动私有服务器（`Standalone.start`）
   - 默认：连接/启动后台服务（`Service.ensure`，版本不匹配时按策略替换）
2. 检查 `--session` 会话是否存在（`findSession`）
3. 启动更新检查（每 10 分钟，信号量保证不重叠安装）
4. 调用 `@opencode/tui` 的 `run`，传入 app/server/args/config/updater/packages

**3. TUI 主应用** — `packages/tui/src/app.tsx`

`Tui.run` Effect 做了：
1. 解析配置（`Config.resolve`）
2. 创建 `OpenCode` Promise 客户端（`@opencode/client`，`fetch: noTimeoutFetch` 防止长会话被 5 分钟默认超时掐断）
3. 获取 Location（先 `api.file.list`，失败则 `api.location.get`）
4. 创建终端渲染器（`@opentui/core` 的 `createCliRenderer`，60 FPS、鼠标支持可配置）
5. 渲染 SolidJS 组件树，Provider 嵌套顺序（从外到内）：

```
LogProvider → ExitProvider → EpilogueProvider → TuiAppProvider → ErrorBoundary
→ TuiPathsProvider → StorageProvider → TuiLifecycleProvider
→ TuiTerminalEnvironmentProvider → TuiStartupProvider → ClipboardProvider
→ ArgsProvider → ConfigProvider → Keymap.Provider → ToastProvider → RouteProvider
→ ClientProvider → PermissionProvider → DataProvider → LocationProvider
→ SessionTabsProvider → SessionTerminalsProvider → ThemeProvider
→ LocalProvider → PromptStashProvider → DialogProvider → FrecencyProvider
→ PromptHistoryProvider → PromptRefProvider → EditorContextProvider
→ AttentionProvider → UpdateNotificationProvider → PanelProvider
→ PluginProvider → App
```

`App()` 组件负责：
- 键盘绑定层（appCommands + appBindingCommands + 会话标签绑定）
- 终端标题更新（`OC | <会话标题>`）
- 事件监听：`tui.command.execute` / `tui.toast.show` / `tui.session.select` / `session.deleted`
- 连接状态显示（重连超时 1s/5s 才显示全屏遮罩）

---

### 阶段 2：服务器端处理（Server → Core）

**4. Server Session 处理器** — `packages/server/src/handlers/session.ts`

`session.prompt` 处理器直接委托给 Core：

```ts
session.prompt({ sessionID, id, text, files, agents, skills, metadata, delivery, resume })
```

处理器层负责把 Core 的类型化错误翻译成 HTTP API 错误（`missingSession`、`ConflictError`、`InvalidRequestError` 等）。

Server 的路由组装在 `packages/server/src/routes.ts`：`applicationServiceNodes` 列表声明了全部核心服务节点（Database、Bus、EventLogger、Job、Project、Worktree、Session、Instance、SessionTransfer、PermissionSaved、Pty、Credential、WellKnown、LocationServiceMap、Watcher 等），通过 `AppNodeBuilder.build` 编译成 Effect Layer。

API 端点契约由 `makeDefaultApi`（`@opencode/protocol/api`）定义，中间件：`LocationMiddleware` / `FormLocationMiddleware` / `SessionLocationMiddleware` + 认证、CORS、授权、Schema 错误层。

**5. Core Session.prompt（入场先于执行）** — `packages/core/src/session/session.ts` + `prompt.ts`

```ts
const prompt = (sessionID, input) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const session = yield* get(sessionID)                    // 1. 加载会话
      const messageID = input.id ?? SessionMessage.ID.create() // 2. 生成/复用消息 ID
      const admitted = yield* Effect.gen(function* () {
        const existing = yield* admission.reconcile({...})     // 3. 幂等调和（重试安全）
        if (existing) return existing
        return yield* Effect.gen(function* () {
          const item = yield* restore(SessionPrompt.prepare(...)) // 4. 准备
          if (session.revert) yield* SessionRevert.commit(...)    // 5. 提交暂存 revert
          return yield* admission.admit({...})                    // 6. 入场（持久事件）
        })
      })
      if (input.resume !== false) yield* execution.wake(sessionID) // 7. 调度执行
      return admitted
    })
  )
```

`SessionPrompt.prepare`（`prompt.ts`）细节：
- 触发插件钩子 `session.prompt`（可改写 prompt/metadata/delivery）
- 物化附件（data URL 解码 / file:// 读取，最大 20MB；图片走 `Image.Service.normalize` 缩放；目录附件展开为条目列表）
- 解析技能引用（`Skill.Service.get` + `Skill.prepare`）

**关键设计**：入场（`session.inbox.enqueued` 持久事件 → `session_inbox` 行）先于执行；`session.inbox.delivered` 投影消费行并原子插入可见消息。复用同一消息 ID 幂等（第一次入场胜出）；跨会话/跨类型复用失败。

**6. SessionExecution（进程本地执行）** — `packages/core/src/session/execution.ts`

- `wake(sessionID)`：启动或合并（coalesce）执行；不同 Session 并发
- 预写日志（Write-Ahead Claim）：开始时 `store.claim(sessionID)`，终端态释放；**关机中断和进程死亡保留 claim** → 下次启动恢复（recovery 是数据库的属性，不是关机钩子的属性）
- `drain()`：`store.get(sessionID)` → `SessionRunner.Service.drain(...)`（经 `instances.provide(session)` 提供 Location 实例服务）

**7. SessionRunner（排水执行）** — `packages/core/src/session/runner/index.ts`

`drain({ sessionID, force, continuation, promotable })` 从持久历史运行一个本地延续，返回：
- `Complete` — 完成
- `Moved { continuation? }` — 会话移到新 Location
- `Reloaded { force, continuation? }` — 需重新加载后继续

**8. SessionStep（一步 = 一个 LLM 调用）** — `packages/core/src/session/runner/step.ts`

`attempt()` 的完整流程：

```
1. 捕获起始快照（snapshots.capture，fork scoped，不阻塞请求）
2. 创建 LLM 事件发布器（createLLMEventPublisher，绑定 sessionID/assistantMessageID/agent/model）
3. llm.stream(prepared.request, prepared.options) 流式请求
4. 逐事件处理：
   - context overflow 且输出未开始 → 记为 overflowFailure（不发布）
   - 其他事件 → publisher.publish(event)
   - tool-call 且非 providerExecuted → fork 纤程：executeTool → toolOutput.truncate
     → publisher.toolExecution / 失败则 publisher.failTool
5. 流结束后（uninterruptibleMask 内）：
   - 等待/中断所有工具纤程，分类工具退出（declines / interrupted / failure）
   - overflow 且输出未开始且可恢复 → Outcome.Compacted()（触发压缩重建同一 Step）
   - Transport 错误且可全量重试 → Outcome.RecoverFull()
   - 可重试错误 → Outcome.Retry / Outcome.Continue（依据 outputStarted）
   - 发布 SessionEvent.Step.Ended（含 finish reason、usage、snapshot、files diff）
6. 返回 Outcome：Completed { needsContinuation } / Retry / Continue / RecoverFull / Compacted / OutputLimit
```

关键原则：**一步是一个逻辑 LLM 调用，没有内存工具循环**；每步从重新加载的历史继续；工具调用在步骤内可并发，但终端结果发布串行化。

---

### 阶段 3：事件回传（Server → TUI）

**9. Core 事件总线** — `packages/core/src/bus.ts`

所有会话操作通过 `Bus.publish(SessionEvent.*)` 发布事件（入场、投递、消息更新、步骤结束、Shell 启动/结束等）。

**10. Server EventFeed（编码一次，多订阅者复用）** — `packages/server/src/event-feed.ts`

```
Core EventV2.listen()
    │ 一次全局订阅（Server Scope 构建）
    ▼
EventFeed.publish
  isOpenCodeEvent 过滤 → render() 一次编码（data: JSON\n\n）
    │ 同一个不可变字符串，非阻塞 Queue.offerUnsafe 给每个订阅者
    ▼
  Queue A / B / C ...（每连接一个 Queue.dropping，容量 4096）
    │
  HTTP SSE 连接
```

- 溢出：该订阅者从集合移除 + `SubscriberOverflowError` 失败；其他订阅者继续
- 编码失败：记录日志 + 所有当前订阅者 `EncodingError` 失败 + 跳过坏事件（Feed 保持可用）
- 无订阅者时 `publish` 直接返回（headless 不付编码成本）

**11. 客户端事件共享** — `packages/client/src/shared-events.ts`

- 多个订阅者共享一条 SSE 连接（`SharedEvents.make`，容量 4096）
- `server.connected` 帧缓存，新订阅者先收到
- 最后一个订阅者离开时中止连接；错误完成传播给所有订阅者

**12. TUI 数据投影** — `packages/client/src/solid/data.ts`（`createData`）

- 监听 `OpenCodeEvent`，事件驱动地更新 Solid store（投影模式）
- 失效读取**串行**重验证（旧响应不能覆盖新响应）；事件突发用 150ms settle 窗口合并重取
- 重连使缓存读取失效；活跃 UI 所有者决定重新同步什么
- `omitToolFileData`：丢弃工具结果中内联 `data:` 文件载荷（防止截图会话保留数百 MB base64）

**13. TUI 界面更新** — Solid 响应式重渲染，显示新消息 / 工具结果 / 状态变化。

---

### 全景图

```
用户在 TUI 输入消息
        │
        ▼
packages/cli (default.ts) ──► packages/tui (app.tsx: Tui.run)
        │                          │ client.api.session.prompt(...)
        │                          ▼
        │                   HTTP POST /session/{id}/prompt
        │                          │
        │                          ▼
        │                   packages/server (handlers/session.ts)
        │                          │ Session.Service.prompt
        │                          ▼
        │                   packages/core (session/session.ts)
        │                     幂等调和 → prepare（钩子/附件/技能）
        │                     → admit（session.inbox.enqueued）→ execution.wake
        │                          │
        │                          ▼
        │                   packages/core (session/execution.ts)
        │                     预写 claim → SessionRunner.drain
        │                          │
        │                          ▼
        │                   packages/core (session/runner/step.ts)
        │                     llm.stream → 工具纤程 → Step.Ended
        │                          │
        │                          ▼
        │                   packages/core (bus.ts) Bus.publish
        │                          │
        │                          ▼
        │                   packages/server (event-feed.ts)
        │                     一次编码 → 每连接独立队列 → SSE
        │                          │
        │                          ▼
        │                   packages/client (shared-events.ts → solid/data.ts)
        │                     共享 SSE 连接 → 投影到 Solid store
        │                          │
        └──────────────────────────┴──► TUI 重渲染（消息/工具/状态）
```

---

## 四、LLM 调用链路笔记（2026-10-26 梳理）

> 从 `SessionStep.attempt` 到 Provider HTTP 请求、再从响应字节流回到 `LLMEvent` 的完整链路。
> 注意：`LEARN.md` 描述的 V1 路径（`packages/opencode/src/session/`）已随包删除而失效，当前代码只有 V2 原生路径。

### 1. 三层职责

```
┌─────────────────────────────────────────────────────────┐
│ Core 编排层 (packages/core/src/session/)                 │
│ 决定"何时调用、调用什么"：Agent/模型选择、历史加载、       │
│ 工具物化、压缩、重试策略、步数限制                         │
├─────────────────────────────────────────────────────────┤
│ AI 协议层 (packages/ai/)                                 │
│ 决定"怎么说这门语言"：通用 LLMRequest → Provider 原生      │
│ body；Provider 事件流 → 通用 LLMEvent                     │
├─────────────────────────────────────────────────────────┤
│ 传输层 (packages/ai/src/route/transport/)                │
│ 决定"怎么送过去"：URL 渲染、认证头、HTTP/WebSocket、      │
│ SSE 切帧、超时与错误分类                                  │
└─────────────────────────────────────────────────────────┘
```

`packages/ai` 的设计原则（其 AGENTS.md）：**与 Session 无关**——认证、权限、插件、编排都在 Core；`LLM.stream` 只执行**恰好一次**模型调用；容忍未知值（`Known | (string & {})`），Provider 新枚举不炸请求。

### 2. 数据流转全景图

```
[持久消息] SessionMessage.Info（DB 中的 user/assistant/tool 消息）
     │
     ▼  toLLMMessages()                    runner/to-llm-message.ts
[通用消息] Message（@opencode/ai/effect）: 文本/媒体/工具调用/工具结果
     │
     ▼  SessionModelRequest.baseTranscript()   session/model-request.ts
[转录] { system: SystemPart[], messages: Message[] }
     │
     ▼  context.request.primary()              session/model-request.ts
[请求准备] Prepared {
     request: LLMRequest,      ← 通用请求（含 model、tools、generation）
     options: StreamOptions,   ← WebSocket 通道等
     executeTool,              ← 绑定了权限检查的工具执行器
     retry                     ← 插件重试钩子
   }
     │
     ▼  SessionStep.attempt → llm.stream(request)     runner/step.ts → ai/llm.ts
     │
     ▼  LLMClient.compile(request)                    ai/route/client.ts
     │   ├─ prepareRequest: 合并 route/model/request 三层默认
     │   │   + 清洗代理字符 + 工具 schema 投影 + 缓存策略
     │   ├─ route.body.from(resolved)  ←★ 协议层：LLMRequest → Provider 原生 body
     │   │     例: Anthropic { model, system, messages, tools, max_tokens, thinking }
     │   ├─ body.schema 验证 → JSON 编码
     │   └─ route.prepareTransport    ←★ 传输层: URL 渲染 + Auth 头 → HttpPrepared
     │
     ▼  transport.execute → RequestExecutor → FetchHttpClient
[HTTP POST] https://api.anthropic.com/v1/messages  (x-api-key: ...)
     │
     ▼  响应字节流
[切帧] Framing.sseEvents → 每行 "data: {...}" → Frame
     │
     ▼  protocol.stream.event (Schema 解码)
[Provider 事件] message_start / content_block_delta / message_stop ...
     │
     ▼  protocol.stream.step(state, event) 状态机      ai/protocols/anthropic-messages.ts
[通用事件] LLMEvent: textDelta / toolCall / reasoningDelta / finish ...
     │
     ▼  回到 step.ts: publisher.publish(event)
[持久事件] Bus → EventFeed → SSE → TUI 实时渲染
```

### 3. Core 编排层实现

**主循环** — `packages/core/src/session/runner/llm.ts`（`SessionRunnerLLM.drain`）：

```ts
const drain = function* (input) {
  let step = input.continuation?.step ?? 1
  while (true) {
    const next = yield* advanceToStep()          // inbox 提升/压缩/移动控制
    if (next._tag !== "Ready") return next       // Complete / Moved / Reloaded
    continuing = yield* runStep(next.context, step)  // 一个逻辑 Step
    step++
  }
}
```

`advanceToStep()` 在每个边界（Location 入口 / idle 边界）：
- `SessionInbox.nextPromotable` — 取下一个待提升输入（steer 优先于 queue；控制项不受限）
- 压缩控制项 → `compaction.compact({ reason: "manual" })` 后 `continue`
- 移动控制项 → `modelTransport.close` → 返回 `DrainResult.Moved`
- 进入前先清理陈迹：`settleStaleCompactions` + `settleStaleToolCalls`（进程死亡后的孤儿调和）

**逻辑 Step 策略** — 同文件 `runStep`（物理尝试循环）：

```
while (true) {
  loaded = initial ?? prepareContext → context.load     // 首次复用边界准备
  compacted = compaction.compact({ reason: "auto" })     // 自动压缩
  transcript = SessionModelRequest.baseTranscript(...)
  prepared = context.request.primary({ ..., inputTokens: 估算 })
  outcome = steps.attempt({ ...prepared, retry, recoverOverflow, recoverContinuation })
  match outcome:
    Completed { needsContinuation } → true 则进入下一逻辑 Step（工具结果已入库）
    Retry / Continue → retry.wait + （Continue 另注入合成续接指令）
    OutputLimit → 连续 3 条 length 结尾才失败；否则注入续接指令
    Compacted → recoverOverflow = false（溢出压缩只做一次）
    RecoverFull → recoverContinuation = false（全量重建只做一次）
}
```

**双层循环语义**：外层 `drain` while = 逻辑 Step 循环（工具调用延续）；内层 `runStep` while = 物理尝试循环（重试/压缩/续接**不消耗步数**）。

**步数限制**：`agent.steps` 达到时，最后一步追加 `MAX_STEPS_PROMPT` 且 `toolChoice: "none"`——**保留工具定义**以保护 Provider prompt cache 前缀。

**请求准备** — `packages/core/src/session/model-request.ts`：

```ts
baseTranscript = {
  providerMetadataKey,                     // route.providerMetadataKey ?? provider
  system: [agent.system || SessionSystemPrompt.make(toolNames), instructions 基线],
  messages: toLLMMessages(messages, modelRef, providerMetadataKey),
}
```

消息映射（`runner/to-llm-message.ts`）：

| Session 消息 | → 通用 Message |
|---|---|
| `user` | 文本 + 附件（图片→`Media.base64`；纯文本→内联文本块；目录→条目列表；mention 图片去重） |
| `assistant` | 扁平化 text / reasoning / toolCall / toolResult 各 part |
| `compaction` | 用户消息 + 压缩摘要检查点 |
| `agent-switched` / `model-switched` | 跳过（不发给模型） |

`primary()` 额外负责：图片大小治理（>25MiB 移除并注入占位说明，目标 15MiB）、输出上限计算（目录 limit.output 按上下文剩余空间收缩，`room = context - measured - estimated*1.15`）。

### 4. AI 协议层实现

**入口** — `packages/ai/src/llm.ts`：

```ts
stream(input) = Stream.unwrap(requestEffect(input) → LLMClient.stream(request))
// request(): 普通对象 → LLMRequest 类（system→SystemPart，prompt→追加 user 消息，tools→ToolEntry[]）
// generateObject(): 强制合成工具调用实现结构化输出（刻意不用 provider 原生 JSON 模式，保证全协议行为一致）
```

**协议编译（核心枢纽）** — `packages/ai/src/route/client.ts` 的 `compile`：

```ts
compile = function* (request, options) {
  // 1. 安全检查：禁止 file:// 引用外发（必须先 Media.file 读入，防路径泄漏）
  // 2. prepareRequest:
  //    resolveRequestOptions — normalizeToolHistory + 三层默认合并:
  //      generation = route.defaults ⊕ model.defaults ⊕ request
  //    sanitizeSurrogates — 清理孤立代理字符（防 Provider 400）
  //    ToolSchemaProjection.tools(dedupe, model) — 工具 schema 按模型能力投影
  //    applyEffortUpdates — effort 标记降级
  //    applyCachePolicy — prompt cache 标注
  // 3. route.body.from(resolved) — ★ 协议降级：通用 → Provider 原生 body
  // 4. route.prepareTransport — ★ 传输准备：URL + Auth + 编码 → HttpPrepared
}
```

**Route 四轴模型**（AI 包核心抽象，`route/client.ts` + `route/protocol.ts`）：

```
Route = Protocol（说什么话）
      + Endpoint（发到哪：baseURL + path 模板）
      + Auth（怎么认证：header / bearer / config 环境变量）
      + Framing（怎么切帧：SSE events / 二进制 event-stream）
```

> 设计原话：*"This separation is what lets DeepSeek, TogetherAI, Cerebras, etc. all reuse `OpenAIChat.protocol` without forking 300 lines per provider."*

`Protocol` 是纯语义契约，只有两侧：

```ts
interface Protocol<Body, Frame, Event, State> {
  body: {
    schema: Schema.Codec<Body, unknown>                   // 请求 body 校验
    from: (request: LLMRequest) => Effect<Body, AIError>  // 通用 → 原生
  }
  stream: {
    event: Schema.Codec<Event, Frame>                     // 帧 → provider 事件
    initial: (request) => State                           // 状态机初值
    step: (state, event) => Effect<[State, LLMEvent[]]>   // 状态机翻译（1 事件 → 0..n LLMEvent）
    terminal?: (event) => boolean                         // 终止信号
    onHalt?: (state) => Effect<LLMEvent[]>                // 流尾冲刷（未闭合工具块等）
  }
}
```

仓库有 **50+ 协议**（`ai/src/protocols/`：openai-chat、openai-responses、anthropic-messages、gemini、bedrock-converse、mistral-chat…）和 **60+ Provider 门面**（`ai/src/providers/`）。

**Provider 门面示例** — `ai/src/providers/anthropic.ts`：

```ts
const auth = Auth.optional(apiKey, "apiKey")
  .orElse(Auth.config("ANTHROPIC_API_KEY"))
  .pipe(Auth.header("x-api-key"))
configure = (input) => AnthropicCompatible.configure({
  auth, baseURL: input.baseURL ?? "https://api.anthropic.com/v1", provider: "anthropic",
})
```

**响应流解析（状态机）** — `streamPrepared`（route/client.ts）：

```ts
frames → decodeEvent（Schema 解码每帧）
       → takeUntil(terminal)                       // 到终止事件为止
       → protocol.stream.step(state, event)        // 状态机翻译
       → Stream.flatMap(fromIterable)              // 1 provider 事件 → 0..n LLMEvent
       → onHalt(state) 冲刷
       → requireTerminalEvent                      // 无 finish/providerError → incomplete-stream
```

### 5. 传输层实现

**RequestExecutor** — `ai/route/executor.ts` + Core 接线 `packages/core/src/effect/app-node-platform.ts`：

```ts
// Bun 的 fetch 有 5 分钟静默超时，必须显式关掉，否则长思考响应被掐断
const withoutBunTimeout = Layer.effect(HttpClient.HttpClient, ...{ timeout: false }...)
export const llmClient = makeGlobalNode({
  service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor],
})
```

- 状态码 ≥400 → 读 body → `classifyProviderFailure` → `AIError`（解析 `retry-after`、`x-ratelimit-*` / `anthropic-ratelimit-*` 限流详情）
- body 截断 2000 字符防日志爆炸；HTML 错误页识别为网关故障

**HTTP transport** — `ai/route/transport/http.ts`：

```ts
jsonRequestParts = endpoint 模板渲染 → http.body 覆盖合并 → Auth 生成认证头
```

### 6. 关键设计总结

| # | 设计 | 位置 | 价值 |
|---|------|------|------|
| 1 | Protocol ≠ 部署（四轴分离） | `ai/route/client.ts` | DeepSeek/TogetherAI 等复用 OpenAIChat 协议零克隆 |
| 2 | 单向翻译状态机 | `Protocol.stream.step` | Provider 事件 → 通用 LLMEvent，上层完全无感 |
| 3 | 双层循环 | `runner/llm.ts` drain + runStep | 逻辑步（工具延续）与物理尝试（重试/压缩）分离 |
| 4 | 最终 Step 保缓存 | `toolChoice: "none"` 仍带工具定义 | 保护 Provider prompt cache 前缀 |
| 5 | 容忍未知 | `knownString<...>` 模式 | Provider 新枚举值不炸请求 |
| 6 | 禁 file:// 外发 | `compile` 引用检查 | 强制本地文件先经 Media.file 读取，防路径泄漏 |
| 7 | Bun 超时显式关闭 | `app-node-platform.ts` | 5 分钟静默超时会掐断长思考响应 |
| 8 | 终止事件强校验 | `requireTerminalEvent` | 流意外中断 → `incomplete-stream` 分类，可触发续接 |

---

## 五、可迁移的 Agent 设计模式（2026-10-26 总结）

> 从本项目中提炼、可复用到其他 agent 开发的架构模式，按"问题 → OpenCode 方案 → 借鉴价值"组织。

### A. 执行模型类（最值得借鉴）

**1. 入场先于执行（Inbox 模式）**

- 问题：任务提交后进程崩溃任务丢失；重复提交产生重复执行
- 方案：`session.prompt` 先写持久事件（`session_inbox` 行）再调度执行；消息 ID 复用时第一次入场胜出（幂等）
- 借鉴：任何"提交→异步执行"的 agent 都适用。实现成本低（一张表 + 一个状态列），换来重启不丢任务、重试安全

**2. 预写日志 + 恢复是数据库的属性**

- 方案：执行开始时写 claim（与 started 事件同事务），终端态释放；进程死亡**保留 claim** → 下次启动恢复
- 原话："recovery is a property of the database, never of a shutdown hook that may not run"
- 借鉴：比"优雅关机时清理"可靠一个量级，适合所有需要崩溃恢复的执行器

**3. 一步 = 一个 LLM 调用，无内存工具循环**

- 方案：每步从重新加载的持久历史继续；工具结果入库后才开启下一步
- 借鉴：多进程扩展和崩溃恢复的前提。反模式：内存里维护 `messages[]` 数组循环——进程重启状态全丢

**4. 双层循环：逻辑步 vs 物理尝试**

- 方案：外层 while = 逻辑 Step（工具延续，消耗 `steps` 预算）；内层 while = 物理尝试（重试/压缩/续接，不消耗预算）。六值 Outcome 枚举（`Completed/Retry/Continue/OutputLimit/Compacted/RecoverFull`）表达所有转移
- 借鉴：把"重试要不要算步数"这个容易糊的问题变成类型系统里的一等公民

**5. 注入合成指令续接**

- 方案：流不完整 → 保留失败的部分 assistant 消息 → 注入 "Continue from where you left off without repeating completed content" → 新 assistant message ID 续跑；输出截断（finish=length）同理，连续 3 条 length 才判失败
- 借鉴：比"整个重试"便宜得多，且保留已生成内容

### B. 上下文管理类

**6. 滚动摘要压缩 + 溢出触发重建**

- 方案：完整转录永远持久化；模型可见历史 = 结构化滚动摘要 + 有界最近上下文；Provider 报溢出且尚无持久输出时压缩一次并重建同一逻辑步（只允许一次）
- 借鉴："持久全量 + 视图压缩"分离，压缩策略可随时改而不丢历史

**7. Prompt cache 保护意识**

- 方案：步数耗尽的最终 Step 设 `toolChoice: "none"` 但保留工具定义，不破坏 Provider 缓存前缀
- 借鉴：工具定义变化会打爆 prompt cache——真金白银的成本优化

**8. 大载荷治理**

- 方案：>25MiB 图片移除并注入占位说明（"此图已被移除，不要凭记忆声称其内容"）；工具结果内联 base64 在客户端投影层丢弃（防截图会话保留数百 MB 内存）
- 借鉴：多模态 agent 的内存/成本防护；占位说明写法值得抄（明确告诉模型"不要假装记得"）

### C. 抽象设计类

**9. Route 四轴：协议 ≠ 部署**

- 方案：`Protocol（说什么话）+ Endpoint（发到哪）+ Auth（怎么认证）+ Framing（怎么切帧）`；DeepSeek/TogetherAI/Cerebras 复用 OpenAIChat 协议零克隆；响应侧单向状态机（`step(state, event) → [state, LLMEvent[]]`）翻译 Provider 事件
- 借鉴：**多 Provider 支持最核心的抽象**。反模式：每个 Provider 一个完整 client 实现

**10. 工具的结构化契约**

- 方案：每次调用携带持久身份（`sessionID/agent/messageID/callID`）；作用域注册（关 Scope 移除注册、露出上一层）；八条法则（单次执行、编解码边界、规范表达……）；拒绝宽泛 try-catch（会吞掉中断和缺陷）
- 借鉴：工具调用可审计、可恢复、可并发的基础。错误三分法：预期失败（ToolFailure，模型可见）/ 中断（不是结果）/ 缺陷（运维失败）

**11. 依赖单向的包分层**

- 方案：`Schema → Core/Protocol → Server → Client → SDK`，Client 永不依赖 Core；客户端代码从 HttpApi 生成 + 等价性测试防漂移
- 借鉴：多接口（TUI/桌面/Web/SDK/CLI）共享一个后端时，防止耦合腐烂的结构性手段

### D. 多客户端与治理类

**12. 事件扇出：编码一次，独立有界队列**

- 方案：Server 对所有连接只做一次 Schema+JSON+SSE 编码，同一不可变字符串分发到每连接的 dropping 队列（容量 4096）；慢订阅者溢出只杀自己
- 借鉴：多客户端实时同步的标准解法（50 客户端编码开销降 97.8%）；共享 PubSub 的四种背压策略都不满足"独立失败"语义时，简单队列反而更好

**13. 三级权限 + 通配符 + 最后匹配胜出 + 组织最终权威**

- 方案：`allow/ask/deny`；策略语句按反向文档序评估（用户全局可覆盖仓库，组织托管 deny 不可被任何 allow 抬起）；权限检查在工具内部（`permission.assert`）而非注册表注入
- 借鉴：企业级 agent 治理的完整模板，尤其"组织策略拥有最终权威"的顺序设计

**14. 容忍未知（前向兼容）**

- 方案：字符串选项用 `Known | (string & {})`；未知事件/状态忽略或透传；只在"文档化形状的错误、已知类型畸形、缺终止事件"时失败
- 借鉴：Provider 每周发新模型新枚举，这条原则直接决定 agent 维护成本

### E. 需要权衡、不宜照搬的部分

| 模式 | 代价 | 何时不要用 |
|------|------|-----------|
| Effect 全家桶 | 学习曲线陡，团队门槛高 | 小团队/脚本型 agent 用普通 async 更划算 |
| 全量事件溯源 | 存储 + 投影复杂度 | 一次性问答型 agent 不需要 |
| 进程本地执行 | 集群化需要 placement + fencing（specs 明确这是未来工作） | 单机部署够用时不用提前设计 |
| 20 层 Provider 嵌套 | TUI 特有复杂度 | Web 端可用更扁平的状态管理 |
| 4096 容量启发式 | 是滞回阈值不是内存上界 | 高吞吐场景需按字节数预算 |

### F. 三条元原则（一句话总结）

1. **状态先于动作**（入场先于执行、claim 先于运行、事件先于投影）——一切可靠性源于此
2. **边界处翻译，内部统一**（Provider 事件→LLMEvent、Session 消息→Message、策略语句→决策）——所有扩展性源于此
3. **把策略表达成数据/枚举，而不是散落的 if**（Outcome 枚举、policy 语句、权限规则）——所有可维护性源于此

---

## 六、学习日志

> 每次学习后追加一条：日期 + 学了什么 + 疑问/发现。

### 2026-10-26

- 梳理了从 TUI 到 LLM 再回传的完整执行流程（三阶段 13 步，见上文第三节）。
- 关键发现：
  - CLI 与 Server 是**分离进程**：默认走后台服务（`opencode serve --service`），TUI 通过 HTTP+SSE 连接；`--standalone` 时同进程内嵌。
  - `noTimeoutFetch` 用于防止 Bun 默认 5 分钟超时掐断长会话事件流（client 侧多处使用）。
  - `session.prompt` 的幂等性靠 `admission.reconcile` + 消息 ID 复用实现，重试安全。
  - Step 级别的重试/压缩/续接都发生在 `step.ts` 的 Outcome 枚举中，Runner 据此决定下一步。
- 遗留疑问：
  - `SessionRunner.drain` 的完整实现（`promotable` steer/queue 语义）还没读。
  - 工具执行内的权限检查路径（`Permission.assert`）未展开。
  - Compaction 的触发阈值与摘要生成逻辑未读。
- 下一步：按「待学习清单」顺序，优先工具权限系统。

### 2026-10-26（续）：LLM 调用链路

- 深入梳理了 LLM 调用链路（三层职责 + 数据流转全景图，见上文第四节），已写入正文。
- 关键发现：
  - **AI 包与 Session 完全解耦**：`LLM.stream` 只做一次模型调用；认证/权限/插件/编排全在 Core。
  - **Route 四轴模型**（Protocol + Endpoint + Auth + Framing）是 `packages/ai` 的核心抽象：50+ 协议、60+ Provider 门面，DeepSeek/TogetherAI 等直接复用 OpenAIChat 协议零克隆。
  - **协议编译枢纽**在 `LLMClient.compile`：file:// 引用安全检查 → prepareRequest（三层默认合并 + 代理字符清洗 + 工具 schema 投影 + 缓存策略）→ `route.body.from` 协议降级 → `route.prepareTransport` 传输准备。
  - **响应侧是单向状态机**：帧 → Schema 解码 → `protocol.stream.step(state, event)` 翻译成通用 LLMEvent；`requireTerminalEvent` 强校验终止事件，缺失则归类 `incomplete-stream`（可触发续接）。
  - **双层循环**：`drain` 外层 while = 逻辑 Step（工具延续），`runStep` 内层 while = 物理尝试（重试/压缩/续接不消耗步数）；`agent.steps` 达限后追加 `MAX_STEPS_PROMPT` 并 `toolChoice: "none"` 但保留工具定义以保护 prompt cache。
  - Bun fetch 的 5 分钟静默超时在两处被显式关闭：Core 的 `withoutBunTimeout`（LLM 请求）和 CLI/TUI 的 `noTimeoutFetch`（事件流）。
- 旧文档勘误：`LEARN.md` 的 V1 路径（`packages/opencode/src/session/`）已失效——`packages/opencode` 包已删除，`llm.ts`/`processor.ts`/`provider.ts` 等文件不复存在；当前唯一路径是 V2 原生（`packages/core/src/session/runner/` + `packages/ai`）。
- 遗留疑问：
  - `ModelResolver.resolveModel` 内部如何把 catalog 模型映射到具体 Route（`fromCatalogModel` 的 provider→route 路由表）。
  - `SessionCompaction.compact` 的摘要生成与 `compaction.precompute` 预计算机制。
  - 工具调用时 `Permission.assert` 的完整评估链（agent 规则 → saved approvals → 插件钩子 → policy）。
- 下一步：工具权限系统（待学习清单第一项）。

### 2026-10-26（续）：可迁移的 Agent 设计模式

- 横向总结：把 OpenCode 的 agent 工程实践提炼为 14 个可借鉴模式 + 5 个需权衡项 + 3 条元原则（见上文第五节）。
- 最核心的三条：状态先于动作、边界处翻译内部统一、策略表达为数据/枚举。
- 应用方向：后续自研 agent 时，优先落地 Inbox 模式 + 预写 claim + Route 四轴（这三个投入产出比最高）；权限治理和事件扇出在多用户场景再加。
- 待办：若启动自己的 agent 项目，把第五节 A 类模式作为设计检查清单。

---

## 七、更新指引（给自己）

每次学习的更新动作：

1. 把「进度追踪」里学完的项改成 `[x]`，补充一行要点。
2. 在对应章节追加笔记（文件路径 + 关键代码行 + 设计原因）。
3. 在「学习日志」按日期追加：学了什么、疑问、下一步。
4. 文档遵循现有约定：中文、路径用反引号、代码块标注文件来源。
