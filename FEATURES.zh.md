# OpenCode 功能图景

本文档梳理 OpenCode（V2）面向用户的完整功能与特性。内容基于仓库中的官方文档（`packages/web/src/content/docs/*.mdx`）及 `README.md`。

> **配套文档**：技术架构、模块划分、依赖方向请参阅 [`ARCHITECTURE.zh.md`](./ARCHITECTURE.zh.md)。

---

## 一、什么是 OpenCode

**OpenCode** 是一个开源 AI 编程代理（AI coding agent），当前版本 **2.1.4**，由 anomalyco 团队开发。

- 官网：<https://opencode.ai>
- V2 文档：<https://opencode.ai/v2/docs/>
- 可作为**终端 TUI、桌面应用、IDE 扩展、CLI** 使用
- 核心理念：让 AI 能够直接在你的代码库里读文件、改代码、运行命令、执行多步任务

### 安装方式

```bash
# YOLO 安装
curl -fsSL https://opencode.ai/v2/install | bash

# 包管理器
npm i -g @opencode/cli@latest      # 或 bun/pnpm/yarn
brew install anomalyco/tap/opencode-v2   # macOS 和 Linux（推荐）
sudo pacman -S opencode            # Arch Linux（稳定版）
mise use -g opencode               # 任意 OS
nix run github:anomalyco/opencode  # Nix
```

桌面应用（BETA）可从 <https://opencode.ai/download> 下载，支持 macOS、Windows、Linux。

---

## 二、Agent 系统（多代理协作）

OpenCode 内置两类 Agent，支持在会话中切换或通过 `@` 提及调用子代理。

### 主代理（Primary，Tab 键切换）

| Agent | 模式 | 说明 |
|---|---|---|
| **Build** | primary | 默认代理，所有工具开启，用于实际开发（读写文件、运行命令） |
| **Plan** | primary | 受限代理，用于分析与制定计划，默认拒绝文件编辑，允许提问 |

### 子代理（Subagent，`@` 提及调用）

| Agent | 模式 | 说明 |
|---|---|---|
| **General** | subagent | 通用多步任务研究与执行，除 `todowrite` 外拥有完整工具权限 |
| **Explore** | subagent | 快速只读代码库探索，不可修改文件 |

系统隐含代理：**Compaction**（上下文压缩）、**Title**（会话标题）、**Summary**（会话摘要），自动运行，不可在 UI 中手动选择。

### 自定义 Agent

可在 `opencode.json` 或 `.opencode/agents/*.md` 中自定义主代理或子代理，指定：
- `model`：使用的模型（如 `anthropic/claude-sonnet-5-5`）
- `prompt`：系统提示词文件
- `permission`：细粒度权限（`allow / ask / deny`）
- `steps`：最大代理迭代步数
- `temperature`：随机性（0.0~1.0）
- `color`：UI 中的显示颜色

---

## 三、内置工具（LLM 可直接调用）

OpenCode 默认内置一组工具，Agent 可在对话中直接调用，所有工具均支持 `allow / ask / deny` 权限控制（支持通配符）：

| 工具 | 用途 |
|---|---|
| `bash` | 执行终端命令 |
| `read` | 读取文件内容，支持按行范围读取 |
| `write` | 创建或覆盖文件 |
| `edit` | 精确字符串替换修改文件 |
| `apply_patch` | 向文件应用补丁 |
| `grep` | 正则搜索文件内容 |
| `glob` | 按模式查找文件（如 `**/*.ts`） |
| `list` | 列出目录 |
| `lsp` | 代码智能（定义、引用、悬停、调用层次），实验性 |
| `skill` | 加载可复用技能（SKILL.md） |
| `todowrite` | 任务清单管理 |
| `webfetch` | 抓取网页内容 |
| `websearch` | 联网搜索（需启用 Exa/Parallel） |
| `question` | 向用户提问，获取澄清或决策 |
| `task` | 调用子代理 |

---

## 四、模型与提供商

- 基于 **AI SDK + Models.dev**，支持 **75+ 个 LLM 提供商**（Anthropic、OpenAI、Gemini、Amazon Bedrock、本地模型等）
- 模型 ID 格式：`provider/model-id`，如 `anthropic/claude-sonnet-5-5`
- 支持 **模型变体（Variants）**：
  - Anthropic：`high`（默认高思考预算）、`max`（最大思考预算）
  - OpenAI：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`（推理力度）
  - Google：`low`、`high`
- 可按 Agent、命令、全局分别配置模型及其选项（`reasoningEffort`、`thinking.budgetTokens`、`textVerbosity` 等）
- 通过 `/connect` 命令完成提供商认证，API Key 存储在本地
- `/models` 命令在 TUI 中选择模型

---

## 五、扩展性体系

OpenCode 的核心优势之一是高度可扩展：

### 1. MCP 服务器（Model Context Protocol）

支持**本地**（`type: "local"`，启动本地命令）和**远程**（`type: "remote"`，HTTP + 自动 OAuth）两类服务器。MCP 工具会自动注册到 LLM 可用列表中。

示例：Sentry、Context7、Grep by Vercel、Jira 等。配置在 `opencode.json` → `mcp`。

### 2. 自定义工具（Custom Tools）

用 TypeScript/JavaScript 编写，放在 `.opencode/tools/`，内部甚至可以调用 Python 等任意语言脚本。基于 Zod 做参数校验，可覆盖内置工具。

### 3. 插件系统（Plugins）

通过事件钩子扩展行为，可从 npm 安装或放在本地 `.opencode/plugins/`。支持的事件包括：

- 工具：`tool.execute.before / after`
- 会话：`session.created / compacted / deleted / idle / updated`
- 消息、文件、权限、LSP、Shell、TUI 等

示例用法：会话空闲时发桌面通知、阻止读取 `.env`、注入环境变量、自定义工具、自定义上下文压缩提示词。

### 4. 技能系统（Skills / SKILL.md）

可复用的指令定义，放在 `.opencode/skills/<name>/SKILL.md`（或兼容 Claude 的 `.claude/skills/`）。Agent 通过原生 `skill` 工具发现并按需加载，支持权限控制（`allow / ask / deny`）。

### 5. 自定义命令（Commands）

在 `.opencode/commands/` 写 markdown，就能用 `/命令名` 触发。支持：
- `$ARGUMENTS` / `$1 $2 ...` 位置参数
- `` !`shell命令` `` 注入命令输出
- `@文件路径` 引入文件内容

内置命令：`/init`（初始化项目生成 AGENTS.md）、`/undo`、`/redo`、`/help`、`/models`、`/connect`、`/update` 等。

---

## 六、配置系统

OpenCode 使用 `opencode.json` / `opencode.jsonc`（支持注释），**多层合并**（非替换，后层仅覆盖冲突键）：

1. 远程配置（`.well-known/opencode`，组织默认）
2. 全局配置（`~/.config/opencode/opencode.json`）
3. 自定义配置（`OPENCODE_CONFIG` 环境变量）
4. 项目配置（项目根 `opencode.json`，可提交 Git）
5. `.opencode` 子目录（agents, commands, plugins, skills, tools, themes）
6. 行内配置（`OPENCODE_CONFIG_CONTENT`）
7. 托管/托管偏好（企业 MDM，最高优先级，不可覆盖）

TUI 专用设置使用 `tui.json`（或 `tui.jsonc`）。

可配置项涵盖：模型、提供商、权限、MCP、插件、Agent、命令、快照、上下文压缩、格式化器、LSP、观察者、图片附件限制、Shell、主题、按键绑定等。支持 `{env:VAR}` 和 `{file:path}` 变量替换。

---

## 七、其他核心能力

| 功能 | 说明 |
|---|---|
| **上下文压缩（Compaction）** | 长会话自动压缩，保留关键上下文，可配置 `auto / prune / reserved` |
| **快照与撤销重做** | 跟踪文件变更，支持 `/undo` / `/redo`，可关闭快照 |
| **会话/子会话** | 支持子会话嵌套（`subagent_depth` 控制深度），可在主会话和子会话间切换 |
| **格式化器（Formatters）** | 内置 Prettier 等，支持自定义格式化命令 |
| **LSP 服务器** | 可配置 TypeScript 等语言服务器（实验性） |
| **图片附件** | 自动调整过大图片，再发给模型 |
| **主题与按键绑定** | `tui.json` 配置主题（如 tokyonight）、光标、滚动、鼠标、键位 |
| **文件监视** | 可配置忽略模式（`watcher.ignore`） |

---

## 八、技术架构简述（配套 ARCHITECTURE.zh.md）

OpenCode 采用 Bun + TypeScript 的 monorepo，核心分层：

```
Schema ──► Core ──► Server
   │          │         │
   └────────► Protocol ──┘
                  ▲
               Client（只能依赖 Schema + Protocol）
                  ▲
               SDK（组合 Client、Core、Server）
```

- 使用 **Effect** 做异步/并发编程
- TUI 基于 **OpenTUI**（Solid.js）
- 核心包：`core`、`server`、`protocol`、`schema`、`client`、`cli`、`tui`、`ui`、`sdk`、`plugin` 等

详细架构请参阅 [`ARCHITECTURE.zh.md`](./ARCHITECTURE.zh.md)。

---

<small>本文档基于仓库中 `packages/web/src/content/docs/` 下的官方说明整理，如有遗漏或过时，欢迎通过 PR 更新。</small>