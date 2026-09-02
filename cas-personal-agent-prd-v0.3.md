# Cas Personal Agent PRD v0.3

- 文档状态：原型优先的 MVP 架构稿（v0.3：合并 grilling 结论；企微日程移出 MVP）
- 日期：2026-09-02
- 主要读者：负责本地开发的 Coding Agent / 开发者
- 部署目标：单台美国 VPS，4C4G 或 4C8G，长期常驻
- 产品形态：单用户、私有部署、飞书 Bot 作为唯一日常入口

---

## 0. 给开发 Agent 的执行指令

本项目不是普通聊天 Bot，也不是把自然语言转换成待办的薄封装。请先完整阅读本 PRD，再围绕“用户倾倒输入 → Agent 自动整理 → 当前状态与外部行动落位 → 等待事项在检查点重新出现”建立最窄可运行闭环。阶段 0—6 是递增实现顺序，不要求等全部基础设施完成后才验证产品行为。每个阶段必须保持可运行、可测试、可回滚；不得为了提前覆盖后续功能而引入 Redis、独立 PostgreSQL、向量数据库、浏览器常驻进程、多 Agent 编排或未经要求的前端。

开发时遵守以下约束：

1. 优先使用 Pi SDK 嵌入 Node.js/TypeScript 服务；若当前版本 SDK 存在阻断性兼容问题，才退回 Pi RPC 模式，并记录 ADR。
2. Pi 负责模型调用、Agent loop、当前 session 与工具调用；长期状态、原始事件和 session rollover 由本项目控制。
3. Hindsight 是长期记忆引擎，不是项目/任务状态的唯一真源。
4. 所有对飞书多维表格的操作必须经过确定性 Adapter，不允许模型自行拼接任意 shell 命令。
5. 生产运行时默认禁用 Pi 的通用 `bash/edit/write` 等高权限工具；开发模式和运行模式必须分离。
6. 所有外部写操作都要有幂等键、审计记录和失败重试路径。
7. 不在代码、日志、测试夹具和 Git 中写入真实 token、OAuth 凭证、客户材料或用户敏感内容。
8. 依赖版本应锁定；升级 Pi、Hindsight 或 lark-cli 时先执行回归测试。
9. 外部执行系统从首个 MVP 开始逐项接入：协同承诺进入飞书任务，个人行动进入滴答；企微日程移出 MVP，只保留 Adapter 接口。Bitable 保存它们与项目/事项的挂载关系。
10. 首个产品验收优先于完整加固：先证明一次自然语言倾倒能被正确拆分、落位、纠正和恢复，再扩大同步范围与主动干预。
11. 飞书消息通过 lark-cli 事件总线长连接（`lark-cli event consume im.message.receive_v1 --as bot`）接收，不部署 webhook 入站端点，不做签名和 challenge 校验。
12. Hindsight 复用宿主机已有的 PostgreSQL 16（加 pgvector 扩展），不启用 pg0，不新起 PostgreSQL 实例。
13. 长期记忆在生产配置中默认启用，并在 Supervisor 侧保留 `MEMORY_ENABLED` 降级开关；开发测试、主动关闭或凭证临时不可用时，对话、状态维护与外部行动仍必须完整可用。

---

## 1. 产品目标

### 1.1 产品愿景

构建一个长期为单一用户服务的 Personal Agent。用户只需要在飞书对话框中自然表达工作安排、进展、等待事项、临时想法、疑问和反思；Agent 负责捕获、判断、整理、维护状态、恢复上下文，并在适当时机压缩用户需要面对的选择。

最终目标不是“记录更多信息”，而是形成一个持续闭环：

```text
用户产生想法和行为
  → Agent 观察并保存事件
  → 更新当前项目/事项状态
  → 形成对用户工作方式的可修正理解
  → 动态分配注意力并采取适度干预
  → 观察干预和实际结果
  → 修正协作策略
```

长期希望 Agent 能逐步理解：用户通常如何拆解模糊任务、在哪些条件下容易岔开、哪些提醒和拆法有效、何时应允许探索、何时应收束执行。它应帮助用户逐渐形成更有条理但不损害创造力的工作方式，而不是让用户对 Agent 形成越来越深的机械依赖。

### 1.2 MVP 要解决的问题

MVP 先闭合以下最小循环：

- 用户可以把脑中的内容直接倒给 Bot，不填写表格。
- Agent 能区分事实、行动、想法、等待、问题和条件预案。
- 想到一件事不等于承诺要做；想法默认不会污染当前待办。
- Agent 能维护“现在处于什么状态”，而不是只保存聊天记录。
- 用户中断后能问“继续那个项目”，快速恢复上次停点。
- Pi 的底层 session 可以无感轮换，不因上下文持续膨胀而失去连续性。
- 长期记忆可跨 session 召回，但记忆故障不能阻断基本对话和状态管理。
- 单台 VPS 上不常驻本地 embedding、reranker 或大模型。
- 明确的个人行动可以写入滴答清单，并在 Bitable 中挂到对应事项。
- 明确的协同承诺可以写入飞书任务，并在 Bitable 中保存责任关系和外部对象。
- 等待事项在用户明确给出的检查点触发一次提醒，不依赖用户自己再记住。

### 1.2.1 首个产品闭环

首个可用原型首先验证以下体验，而不是先证明所有基础设施已经完备：

1. 用户像“倒垃圾”一样说出混合内容，不需要先判断它属于哪个系统。
2. Agent 自动区分事实、个人行动、协同承诺、有时间约束的安排、等待、想法、条件预案和资料线索。
3. Agent 自动更新 Bitable 当前状态，并将明确行动挂载到对应外部执行系统；不确定但可逆的归类先按推荐默认执行，在回复中简短告知。
4. 用户只在理解有误或缺少不可编造的关键事实时纠正；人工修改成为权威纠正。
5. 已到明确检查点的等待事项主动重新出现；没有明确时间的想法不制造提醒。
6. 中断后可通过“继续那个项目”恢复停点、阻塞和唯一下一步。

### 1.3 MVP 不解决的问题

以下能力保留接口，但不进入首个可用版本：

- 企业微信日程的写入与同步（Adapter 接口保留，接入放到 P1）。
- 滴答与飞书任务之间的复杂全双向字段同步与自动冲突合并。
- 未经确认自动向同事发送消息、给他人分配任务、邀请参会人或修改已有外部承诺。
- 全天主动监听微信、邮件、企微和本地文件夹。
- 多 Agent、并行子 Agent、复杂工作流编排。
- 自动浏览网页、国内外搜索路由和浏览器常驻。
- 机械式每日汇总、完整行为实验、个性化强化学习或自动重写稳定策略。
- 独立 Web 前端。
- 多用户和企业级权限体系。

这些能力进入后续阶段，不能成为 MVP 上线的前置条件。

---

## 2. 核心设计原则

1. **一个入口。** 用户只在飞书 Bot 中对话，不负责判断信息该去哪。
2. **表格是 current state，不是聊天历史。** 多维表格只呈现当前项目与事项状态。
3. **原始事件不可被摘要覆盖。** 用户原话、Agent 回复、工具调用和执行结果追加保存。
4. **想法不等于任务。** “我在想、也许、有没有可能”默认作为探索性内容，而非行动承诺。
5. **当前不可行动的事项退出注意力。** 等待、挂起和尚未触发的条件分支不进入“现在做什么”。
6. **一个 active 事项只有一个当前下一步。** 后续可能动作放入条件预案或稍后区。
7. **记忆与确定状态分离。** Hindsight 回答“过去知道和经历过什么”；Bitable 回答“现在是什么状态”。
8. **长期理解是可撤回的假设。** Agent 对用户行为模式的判断必须有证据、置信度和适用范围。
9. **注意力是动态计算结果。** 不要求用户给所有事项永久标注固定优先级。
10. **模型可替换，个人状态不可丢。** Pi、模型或 OAuth 发生变化时，事件、状态和记忆仍可迁移。
11. **外部系统失败时可降级。** Hindsight、Cloudflare 或 Bitable 临时失败时，Bot 仍应给出可理解响应。
12. **运行时最小权限。** 生产 Agent 不直接拥有任意 shell、文件写入和外部通信权限。
13. **一个事实只有一个归属系统。** Bitable 负责项目、推进事项和关系；滴答、飞书任务分别负责其原生执行对象（后续接入的企微日程同理）。Bitable 镜像外部状态并保存对象 ID，不与原生系统争夺同一执行事实。
14. **人工修改是权威纠正。** 用户在 Bitable 或外部执行系统中的手动修改优先于旧摘要、模型推断和长期记忆。事实源在 Agent 触碰相关事项或回答“现在该做什么”时按需读取，MVP 不做后台轮询。
15. **主动提醒必须有明确依据。** MVP 只按用户明确给出的时间、deadline 或等待检查点触发一次提醒，不猜测提前量，不做机械日报。

---

## 3. 总体架构

```mermaid
flowchart TD
    U[用户] --> FB[飞书 Bot]
    FB --> EV[lark-cli event consume\n长连接 / NDJSON]
    EV --> S[Supervisor / Personal Agent Service\nNode.js + TypeScript]

    S --> E[(events.sqlite\n原始事件 / session registry / outbox)]
    S --> C[Context Assembler]
    C --> P[Pi Agent Runtime\nOpenAI OAuth]

    S --> H[Hindsight API Slim\n127.0.0.1 only]
    H --> PG[(宿主机 PostgreSQL 16\n+ pgvector)]
    H --> CF[Cloudflare Workers AI\nQwen3 Embedding 0.6B]
    H --> HO[Hindsight LLM\nOpenAI Codex OAuth]

    P --> T[受控 Tool Layer]
    T --> LA[Lark Adapter]
    LA --> LC[lark-cli]
    LC --> B[飞书多维表格]

    T --> WT[飞书任务]
    T --> DD[滴答]
    T -. P1 .-> WC[企微日程]
```

### 3.1 组件职责

| 组件 | 职责 | 不承担的职责 |
|---|---|---|
| 飞书 Bot | 单一输入输出界面；消息经 lark-cli 事件长连接进入，回复经 lark-cli 发送 | 不维护业务状态 |
| Supervisor | 幂等、队列、上下文组装、session 生命周期、工具权限、降级 | 不自行做自然语言推理 |
| Pi | 当前回合推理、调用受控工具、组织回复 | 不作为长期记忆和唯一状态库 |
| SQLite | 原始事件、session 元数据、交接卡、outbox、提醒登记、审计 | 不做向量搜索 |
| Hindsight | retain、recall、reflect、观察与 mental model | 不作为任务状态和 deadline 真源 |
| 飞书多维表格 | 面向人和 Agent 的项目/事项当前状态、关系与外部行动挂载 | 不保存全部原始聊天历史，不替代外部系统的执行事实 |
| lark-cli Adapter | 确定性调用飞书能力、结构校验、幂等 | 不让模型直接拼接命令 |
| 滴答 Adapter | 创建个人行动、读取人工修改后的任务状态 | 不保存项目完整上下文 |
| 飞书任务 Adapter | 创建协同承诺、读取负责人和执行状态 | 不自动替用户向他人作出未经确认的承诺 |
| 企微日程 Adapter（P1） | 接口占位；后续创建有明确起止时间的公司日程 | MVP 不实现 |

### 3.2 Pi 的接入方式

优先方案：在 TypeScript Supervisor 中使用 Pi SDK，使用可持久化的本地 SessionManager 和多 session runtime。这样可以直接控制创建、加载、退休 session，并减少额外 RPC 进程和协议层。

备选方案：若 SDK 版本存在阻断问题，使用 `pi --mode rpc` 作为受管子进程。RPC 客户端必须遵守 LF 分隔 JSONL 协议，不能使用会错误拆分 Unicode 行分隔符的通用 line reader。

禁止方案：以交互式 Pi CLI 长期挂在 tmux 中，再由 Bot 模拟键盘输入。

---

## 4. 技术选型冻结

| 层 | MVP 选型 |
|---|---|
| 主语言 | TypeScript / Node.js |
| Agent harness | Pi Coding Agent SDK；RPC 为兼容性备选 |
| 主模型认证 | OpenAI/Codex OAuth，由 Pi 管理 |
| 长期记忆 | Hindsight API Slim，单一私有 bank |
| Hindsight 数据库 | 宿主机已有 PostgreSQL 16 + `pgvector`，独立 `hindsight` 库；不启用 pg0（ADR-0003） |
| Embedding | Cloudflare Workers AI `@cf/qwen/qwen3-embedding-0.6b` |
| Embedding 协议 | Cloudflare OpenAI-compatible `/v1/embeddings` |
| Reranker | `rrf`，MVP 不启用本地或外部 reranker |
| Hindsight 内部 LLM | `openai-codex` OAuth，使用独立 `CODEX_HOME` |
| 当前状态 | 飞书多维表格：`项目`、`事项` 两张核心表，`行动同步` 为后台挂载表 |
| 飞书调用 | 官方 lark-cli，经项目 Adapter 封装；消息接收走 `lark-cli event consume` 长连接（ADR-0004） |
| 外部执行 | 飞书任务、滴答，各经独立确定性 Adapter 接入；企微日程 Adapter 只留接口 |
| 原始事件/内部元数据 | SQLite，WAL 模式 |
| 进程管理 | systemd；不要求 Kubernetes、Redis 或消息队列 |
| 部署方式 | 主服务与 lark-cli 运行在宿主机；Hindsight 可用独立 venv/systemd，是否容器化由实现验证决定 |

### 4.1 Hindsight 推荐环境变量骨架

以下仅为目标配置结构，开发 Agent 应根据锁定版本的官方配置名校验后生成 `.env.example`：

```bash
# Hindsight core
HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:${HINDSIGHT_DB_PASSWORD}@127.0.0.1:5432/hindsight
HINDSIGHT_API_HOST=127.0.0.1
HINDSIGHT_API_PORT=8888
HINDSIGHT_API_WORKERS=1
HINDSIGHT_API_MCP_ENABLED=false

# Hindsight LLM via a dedicated Codex OAuth home
HINDSIGHT_API_LLM_PROVIDER=openai-codex
HINDSIGHT_API_LLM_MODEL=${HINDSIGHT_LLM_MODEL}
CODEX_HOME=/var/lib/cas-agent/hindsight-codex
HINDSIGHT_API_LLM_MAX_CONCURRENT=2
HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT=1
HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT=1

# Cloudflare OpenAI-compatible embeddings
HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai
HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1
HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=${CLOUDFLARE_API_TOKEN}
HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=@cf/qwen/qwen3-embedding-0.6b
HINDSIGHT_API_EMBEDDINGS_MAX_INPUT_TOKENS=8192

# No model reranker in MVP
HINDSIGHT_API_RERANKER_PROVIDER=rrf
```

### 4.1.1 Supervisor 记忆开关

```bash
MEMORY_ENABLED=true             # 生产目标；开发测试或显式降级时可置 false
HINDSIGHT_BASE_URL=http://127.0.0.1:8888
HINDSIGHT_RECALL_TIMEOUT_MS=2000
```

生产阶段 1 验收时该开关必须为 `true`，并完成真实 retain 与跨 session recall。开关为 `false` 时 Supervisor 跳过 recall 与 retain，不报错、不向用户提示降级；开关开启但 Hindsight 不可达时按 7.5 降级。

Embedding 模型与维度在创建真实记忆后视为冻结配置。更换不同维度模型前必须执行迁移或重建，不允许直接替换后继续写入。

### 4.2 中文检索边界

Hindsight 的默认 PostgreSQL native BM25 对中文分词能力有限。MVP 的中文召回主要依赖 Qwen3 多语言 embedding、时间检索和关系检索；不得假设默认 BM25 能正确处理中文。首版不为此引入 PGroonga、ParadeDB 或新的 PostgreSQL 服务，但必须建立中文 recall 回归集。若实际召回不达标，再单独评估中文 BM25 backend 或 reranker。

---

## 5. 数据模型

## 5.1 SQLite：机器内部事实与审计

### `events`

追加式保存每一次外部输入和系统处理结果。

```text
id                    UUID / ULID
source                feishu | internal | scheduler | tool
source_message_id     飞书 message_id，唯一索引
received_at
user_id
raw_text
raw_payload_json
logical_conversation_id
pi_session_id
parsed_intent_json
related_project_ids_json
related_item_ids_json
assistant_reply
processing_status     received | processing | completed | degraded | failed
error_json
created_at / updated_at
```

### `pi_sessions`

```text
id
logical_conversation_id
pi_session_id
pi_session_path
status                active | retiring | retired | failed
created_at
last_activity_at
retired_at
turn_count
estimated_context_tokens
compaction_count
handoff_id
rollover_reason
```

### `session_handoffs`

```text
id
from_pi_session_id
to_pi_session_id
created_at
current_focus_json
confirmed_facts_json
open_loops_json
decisions_json
uncertainties_json
do_not_repeat_json
next_entry_point
reference_ids_json
source_event_range_json
validation_status
```

### `focus_state`

只保存用户当前工作注意力，不作为长期项目表。

```text
logical_conversation_id
mode                  explore | structure | decide | execute | recover | reflect | unknown
active_project_id
active_item_id
focus_started_at
last_confirmed_at
parking_lot_count
```

MVP 可以只使用 `execute / explore / unknown`，但 schema 保留完整枚举。

### `outbox`

用于 Bitable、Hindsight、滴答和飞书任务的异步写入与重试。

```text
id
operation_type
idempotency_key
payload_json
status                pending | running | succeeded | retry | dead
attempt_count
next_attempt_at
last_error_json
created_at / updated_at
```

### `reminders`

登记到期提醒；服务重启后仍须触发。

```text
id
item_record_id        Bitable 事项 record id
project_record_id     可空
fire_at               触发时间，来自用户明确给出的检查点 / deadline / 安排开始时间
kind                  checkpoint | deadline | scheduled_event
status                pending | fired | cancelled | failed
payload_json          触发时需要的简短上下文（事项名、在等什么、建议动作）
source_event_id
fired_at
created_at / updated_at
```

## 5.2 飞书多维表格：当前状态

### 表一：`项目`

用户正常可见字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| 项目名 | 文本 | 唯一、可读名称 |
| 目标 | 长文本 | 一句话说明最终想达到什么 |
| 阶段 | 单选 | 需求沟通、方案、报价、审批、实施、验收、日常运营、个人计划等 |
| 状态 | 单选 | 在跟、暂停、结束 |
| 当前摘要 | 长文本 | 当前进展、关键阻塞和近期变化 |
| 关联事项 | 关联记录 | 自动关联 `事项` |
| 最近更新 | 日期时间 | 系统维护 |

隐藏系统字段：

```text
project_key
source_event_id
last_effective_event_id
confidence
created_by_agent
```

### 表二：`事项`

用户正常可见字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| 事项 | 文本 | AI 提炼后的可识别名称 |
| 项目 | 关联记录 | 无明确项目时可为空，不强制归“杂事” |
| 状态 | 单选 | 收件箱、可行动、进行中、等待、已排期、完成、放弃、归档 |
| 下一步 | 长文本 | 当前唯一、可直接开始的动作 |
| 在等什么 | 长文本 | 人、结果、材料、时间或其他解除条件 |
| 检查点 | 日期时间 | 等待事项或暂存内容何时重新进入注意力；不是任务 deadline 或会议时间 |
| 关联行动 | 关联记录 | 自动关联 `行动同步`，一条事项可挂多个外部任务或日程 |

默认隐藏字段：

| 字段 | 说明 |
|---|---|
| 类型 | 任务、想法、问题、决策、信息 |
| 当前摘要 | 当前上下文和已知事实 |
| 条件/预案 | 例如“若周五无回复则联系张总” |
| 来源事件 | SQLite event id 或可追溯标识 |
| 相关资源 | 文档、文件、渠道或链接摘要 |
| 最近更新 | 系统维护 |
| 解析置信度 | 供调试，不进入普通视图 |

注意：`类型=想法` 与 `状态=等待/归档` 是正交维度，禁止把“想法”混入状态枚举。

### 5.3 飞书多维表格：`行动同步` 后台表

一行代表一个明确可执行的行动或必须在特定时间发生的日程，并把它挂到对应项目/事项。该表主要供 Agent、同步程序和异常排查使用，不作为用户日常任务清单。

| 字段 | 说明 |
|---|---|
| 行动 | 可读的任务或日程标题 |
| 所属项目 / 事项 | 关联 Bitable 中的上下文与推进线程 |
| 行动类型 | 个人行动、协同承诺、时间安排 |
| 事实源 | 滴答、飞书任务、Bitable；企微日程为 P1 保留枚举值 |
| 外部对象 ID / 链接 | 外部对象创建后填写；Bitable 暂时持有的时间安排为空 |
| 负责人 | 自己、同事或其他明确责任人 |
| deadline | 可执行动作最迟何时完成；没有明确时间时为空 |
| 开始 / 结束时间 | 时间安排的明确起止；MVP 由 Bitable 持有，P1 接入企微日程后由企微持有 |
| 外部状态镜像 | 最近从事实源读取到的状态 |
| 最近同步 / 人工修改时间 | 判断新旧与发现权威纠正 |
| 同步状态 | pending、succeeded、retry、conflict |
| 来源事件 / 幂等键 | 可追溯并防止重复写入 |

边界：日程只承载必须在特定时间发生的事情；任务承载可以执行并完成的动作；事项保存事情为什么存在、现在到哪了以及下一步为什么是它。同一执行字段只由其事实源拥有，Bitable 负责关联和镜像。

### 5.4 推荐视图

MVP 只创建以下视图：

- `现在`：可行动、进行中、已到时间的事项；默认不超过少量 focus items。
- `等待`：状态为等待，按检查时间排序。
- `稍后`：想法、未激活候选、暂时挂起的内容。
- `全部事项`：管理与调试用，不作为日常入口。

---

## 6. 核心交互与处理流程

### 6.1 自然语言捕获

用户可能一次说出多个对象：

> 张总说这周应该有反馈，周五没消息我再找他。晚上把病理那页 PPT 改一下。数据治理那里也许可以换个讲法，不过先别管。

系统应完成：

1. 原文立即写入 `events`。
2. 找到或创建相关项目/事项。
3. 将方案事项设为“等待”，写明等待对象和周五 review 时间。
4. 保存条件预案：“若周五无反馈 → 联系张总”。
5. 创建或更新一个可行动事项：“修改病理 PPT 页”，并将明确的今晚行动写入滴答，在 `行动同步` 中挂回该事项。
6. 将“数据治理换讲法”保存为 `类型=想法`、处于稍后区，不进入当前 focus。
7. 为周五检查点登记一次性等待提醒。
8. 用简短回复说明本轮做了哪些改变，不要求用户填字段。

示例回复：

> 已更新：方案继续等张总，周五无反馈我会提醒你再跟；今晚修改病理页已写入滴答并挂到对应事项。数据治理的新讲法先暂存，不打断当前事项。

### 6.2 避免不必要确认

以下操作可自动执行并在回复中告知：

- 保存原始事件。
- 新建或更新用户自己的项目/事项状态。
- 将明显的探索性想法放入稍后区。
- 设置用户明确说出的日期、等待对象和条件预案。
- 给用户自己创建明确的滴答任务。
- 修正 Agent 自己生成的摘要。

以下情况应询问一个最小问题，或标记为待确认：

- 同一句话可能关联两个活跃项目，且错误关联会影响后续状态。
- 用户未明确给出日期，Agent 不能自行编造硬 deadline。
- 需要把“想法”升级成外部承诺。
- 要给别人创建任务、发消息或改变他人的承诺。

### 6.2.1 外部执行路由与挂载

Agent 先识别语义，再选择执行系统；不能仅因为一句话包含日期就一律创建日程：

- 个人可执行且可以完成的动作 → 滴答；明确 deadline 写入任务时间。
- 与飞书同事有关的分工、交付或协同承诺 → 飞书任务；影响他人前做最小确认。
- 必须在明确起止时间发生的会议、预约或日程 → 创建 `行动同步` 中的“时间安排”，由 Bitable 暂时持有开始/结束时间并挂回事项，同时登记一次 `scheduled_event` 提醒；不占用事项检查点，也不创建外部日程（企微日程接入放到 P1）。
- 等人、等审批、等结果 → 事项的等待状态与检查点；到点由 Agent 提醒，不提前创建尚未触发的行动。
- 想法、资料位置和背景事实 → 留在事项、事件或资料关联中，不污染外部任务系统。

每次外部创建成功后，都必须把事实源、外部对象 ID/链接、所属项目/事项、来源事件、幂等键和最近同步结果写入 `行动同步`。用户在任何事实源中的手动修改是权威纠正；Agent 下一次读取或同步时应更新 Bitable 镜像，不得以旧摘要或记忆覆盖。

事实源读取时机（MVP）：Agent 触碰某个挂有行动的事项、用户询问“现在该做什么 / 我在等什么”、或到期提醒触发时，Supervisor 按需调用 `action.get_external_state` 读取该行动的最新状态并刷新镜像；不做后台轮询，不订阅外部 webhook。

### 6.3 岔开时的处理

当当前 focus 为 A，用户突然提出 B：

- 先保存 B，判断它是想法、信息还是行动。
- 除非 B 有硬时间约束或明显高风险，不自动切换 active focus。
- 回复中用一句话说明 B 已保存，并指出 A 的当前最小闭环动作。
- 处于 `explore` 模式时不得机械拉回，应允许关联和发散；只有在 `execute` 模式下才优先维持焦点。

### 6.4 查询“我现在该做什么”

MVP 使用确定性规则生成候选集，LLM 负责解释和压缩，而不是自由编造优先级：

```text
硬时间约束
+ 已经过 review_at / deadline
+ 能解除其他阻塞
+ 当前项目重要性与显式承诺
+ 与当前 focus 的连续性
+ 长期未推进但仍有效
- 当前被阻塞
- 切换成本
- 仅为想法或尚未触发的条件分支
```

输出应尽量控制在 1–3 个 focus item，但不能为了数量限制隐藏当天硬约束和已逾期外部承诺。

### 6.5 等待管理

状态为“等待”的事项必须包含：

- 等谁/等什么；
- 从什么时候开始等；
- 什么条件解除；
- 何时重新检查；
- 若继续没有结果，是否存在条件预案。

用户明确给出 review 时间时，MVP 必须登记一次提醒，并在该检查点把事项重新推到用户眼前；不自行猜测提前量，不机械发送每日汇总。没有 review 时间的等待事项不应永久沉底，用户查询“我在等什么”时应提示缺少检查点，但不得编造 deadline。

---

## 7. 长期记忆设计

### 7.1 三层信息边界

```text
原始事件（SQLite）
  = 实际发生过什么，永不被记忆摘要替代

当前状态（Bitable）
  = 现在处于什么状态，供行动与筛选

长期记忆（Hindsight）
  = 从过去事件中可召回的事实、经历、观察和 mental model
```

### 7.2 Retain 策略

不是每条原始消息都无差别写入 Hindsight。以下内容优先 retain：

- 用户明确表达的长期协作偏好和边界。
- 用户对 Agent 判断的纠正。
- 重要项目变化、承诺、决策及其原因。
- 任务完成/失败结果，以及对拆解方式和提醒方式的反馈。
- 具有跨项目复用价值的反思、方法和经验。
- Session rollover 交接卡。

以下内容默认不 retain，或只保留脱敏摘要：

- 密钥、登录凭证、身份证件、完整医疗材料等高敏感内容。
- 原始附件全文和大型文档。
- 一次性的低价值寒暄、重复确认和工具噪声。
- 未经确认的 Agent 猜测。

Retain 应通过 SQLite outbox 异步执行。Hindsight 故障不得阻塞用户当前回复；失败任务进入重试队列。

原型期简化（阶段 1–3）：直接复用本回合的结构化整理结果，只 retain 用户明确纠正、长期偏好与边界、重要项目变化或决定、行动结果反馈和 session handoff；其余原话继续完整保存在 SQLite，不重复灌入 Hindsight。更细的候选评分、去重和 reflect 策略在阶段 4 与中文回归集一起落地。

### 7.3 Recall 策略

每个用户回合前由 Supervisor 做轻量 auto-recall，而不是完全交给 Pi 决定是否想起：

```text
query = 当前用户消息
      + 当前项目/事项名称
      + 当前 cognitive mode
      + 必要的时间范围或人物
```

召回结果必须限制条数和 token 预算，并标注来源。当前状态字段优先于记忆推断；若记忆与当前状态冲突，Agent应指出冲突或采用最近确认的 current state，不得自行合并成新事实。

提供一个受控 `memory_search` 工具，供 Pi 在用户明确追溯历史或普通 auto-recall 不足时使用。

### 7.4 Reflect 与 mental model

MVP 不在每一轮调用 `reflect`。Reflect 成本和延迟较高，应只用于：

- 用户主动要求复盘。
- 后续的周期性行为分析。
- 形成或刷新“用户怎样拆任务更有效”等长期模型。

首版先积累事件和记忆，后续建立以下 mental model：

- 用户如何拆解模糊工作。
- 用户在什么条件下容易提前切换注意力。
- 哪种提醒和恢复方式实际有效。
- 什么时候属于有效探索，什么时候属于执行回避。
- 哪类想法后来产生了真实价值。

任何行为结论都应被视为有证据、可更新、可撤回的 claim，而不是永久人格标签。

### 7.5 Cloudflare 失败降级

- Recall 的 embedding 请求设置短超时；失败时跳过长期记忆注入，继续使用 current state 和近期对话。
- Retain 失败进入 outbox 重试，不阻断回复。
- 超出免费额度或出现 429 时记录明确错误，不进行无限重试；延迟到次日窗口或由管理员改用付费额度。
- 不自动切换到本地 embedding，避免突然拉高 VPS 内存。

---

## 8. Session 与上下文生命周期

### 8.1 基本模型

用户看到的是一个长期逻辑对话：

```text
logical_conversation = cas-main
```

后台可以不断更换物理 Pi session：

```text
pi-session-001 → 002 → 003 → ...
```

Pi session 只是工作记忆，可以退休；用户模型、项目状态和历史事件不能依赖某个 session 存活。

### 8.2 正常 compaction

保留 Pi 默认的自动 compaction，用于一次 session 内的短期续航。需要记录每次 compaction 发生的时间和累计次数。Pi compaction 有损，但完整 JSONL 历史必须保留。

### 8.3 自动 rollover 触发器

以下条件任一满足时，在当前回合完整结束后进入 rollover 候选：

- session 已发生两次或以上 compaction；
- 上下文使用率在回合结束后仍超过可配置阈值；
- session 持续时间、回合数或工具输出量超过可配置上限；
- 话题发生明确大切换，且当前 open loops 已持久化；
- 上一次上下文溢出恢复事件发生。

具体数值全部配置化，不写死在业务代码。MVP 初始建议以“compaction_count >= 2”为主触发器，其他规则作为保护。

### 8.4 Rollover 流程

```text
完成当前 turn 和所有 tool result
  → flush SQLite / Bitable / outbox 状态
  → 生成结构化 handoff
  → schema 校验
  → 新建 Pi session
  → 注入核心协作规则
  → 注入 current state
  → 注入 handoff
  → 注入少量近期原始消息
  → Hindsight recall 相关长期记忆
  → 标记新 session active、旧 session retired
```

Handoff 只保存恢复工作需要的信息，不做全文摘要。最少字段：

- 当前 focus 与 cognitive mode；
- 已确认事实；
- 尚未闭环的问题；
- 等待和条件预案；
- 最近决策与原因；
- 不应重复尝试的路径；
- 下一次最适合从哪里进入；
- 相关 project/item/event/document id；
- 仍不确定的内容。

### 8.5 Rollover 失败处理

- Handoff 生成或校验失败：继续使用旧 session，记录错误，下一回合后重试。
- 新 session 启动失败：不退休旧 session。
- Hindsight 不可用：可使用 handoff + current state + 近期消息启动新 session。
- 对用户默认无提示；只有连续失败导致上下文风险时才提示系统处于降级状态。

---

## 9. 受控工具层

Pi 只看到语义稳定的高层工具，不直接面对 lark-cli 的大量命令：

```text
state.get_current_context
state.search_projects
state.search_items
state.upsert_project
state.upsert_item
state.set_waiting
state.set_focus
state.complete_item
state.park_idea
action.create_personal_task
action.create_collaborative_task
action.create_scheduled_event  # MVP：在 Bitable 中保存时间安排
action.create_calendar_event   # 接口保留，MVP 不启用（企微日程 P1）
action.get_external_state
action.record_authoritative_correction
reminder.schedule_checkpoint
memory.search
memory.reflect          # MVP 可默认关闭
```

Adapter 内部再调用 lark-cli 或滴答接口。所有工具必须：

- 使用 JSON Schema / TypeScript 类型校验；
- 返回机器可解析结果；
- 接受 idempotency key；
- 对日期、枚举和 relation id 做确定性验证；
- 记录 event_id、session_id、tool_call_id；
- 支持 dry-run 测试；
- 不把 lark-cli 原始 stderr 直接暴露给最终用户。

运行模式下默认不向 Pi 暴露：

```text
bash
write
edit
任意 HTTP 请求
任意文件系统遍历
```

开发/维护入口可以在独立 profile 下保留这些能力。

---

## 10. 非功能需求

### 10.1 资源占用

在 4C4G 环境上也应可运行：

- 不部署本地 LLM、embedding、reranker、Chromium、Redis，也不新起 PostgreSQL 实例；Hindsight 复用宿主机已有的 PG16。
- Hindsight 只运行 API，不启用 Control Plane UI 常驻。
- Hindsight worker 数为 1，模型调用并发受限。
- SQLite 使用 WAL，日志轮转，不无限增长。
- 主服务空闲时不启动不必要的子进程。
- 应记录 Supervisor、Pi、Hindsight 的 RSS；长期部署前总空闲应用 RSS 目标不高于约 1.5GB，硬性评估线不高于 2GB，以便为系统和突发任务保留余量。该目标不含宿主机既有进程（PG16、sing-box、cloudflared、tailscaled，约 0.8GB）。

若达不到目标，先分析依赖和进程，不得直接升级为多台服务器或引入新的基础设施。

### 10.2 延迟

- 普通捕获/查询不调用 reflect。
- Hindsight recall 设置超时，超时后降级。
- Retain 默认异步。
- 用户应先收到有用结果，而不是等待后台记忆 consolidation 完成。

### 10.3 可靠性

- 飞书事件投递以 `message_id` 去重；lark-cli 事件总线可能重复投递，`event_id` 不作为去重键。
- 重试不得创建重复项目、事项或记忆。
- Bitable 写入与本地 event 状态不一致时进入 outbox 修复。
- 外部创建成功后必须保存对象 ID；重试不得重复创建任务或日程。
- 读取到用户在 Bitable、滴答或飞书任务中的人工修改时，将其记录为权威纠正并刷新相关镜像。
- 不允许 Bitable 镜像反向覆盖事实源中更新更晚的人工修改。
- 服务重启后能恢复 active logical conversation 和 Pi session。
- 登记的提醒持久化在 SQLite `reminders` 表，服务重启后到期提醒仍会触发。
- 所有持久化目录必须有每日备份脚本和恢复文档。

### 10.4 安全

- 只允许配置中的飞书 user id 使用 Bot。
- 消息接收由 lark-cli 事件总线长连接承担，不暴露任何入站 HTTP 端口；lark-cli 事件 daemon 只监听本地 UDS。
- Hindsight 仅绑定 127.0.0.1，不公开端口。
- Cloudflare token 使用最小权限，放入受保护环境文件。
- Pi 与 Hindsight 使用分离的 OAuth 存储目录。
- lark-cli 使用最小飞书权限：bot 身份只需消息收发、多维表格、任务相关 scope，不授予成员管理、邮件等无关 scope。
- 外部内容被视为不可信输入，不能通过提示注入绕过工具权限。
- 公司/政企/医院材料默认只 retain 必要摘要和元数据；附件全文进入海外模型或 Cloudflare 前必须有显式策略。

### 10.5 可观测性

结构化日志至少包含：

```text
trace_id
event_id
source_message_id
logical_conversation_id
pi_session_id
project_id / item_id
tool_name
tool_latency
hindsight_latency
processing_status
error_code
```

提供本地管理员命令或脚本，查看：

- 当前 active session；
- context/compaction 统计；
- pending outbox；
- 最近失败事件；
- Hindsight/Cloudflare/Bitable health；
- 滴答、飞书任务的 pending/failed/conflict 同步；
- 待触发与已触发的提醒；
- 当前资源占用。

---

## 11. MVP 功能需求与验收标准

### FR-01 飞书单用户对话

- Bot 能接收指定用户私聊消息并回复。
- 同一 `message_id` 的重复事件投递不产生重复处理。
- 未授权用户收到拒绝，不进入 Agent。

### FR-02 原始事件留存

- 每条输入在模型调用前写入 SQLite。
- 回复、工具调用、错误和关联对象可追溯。
- 摘要修改不会覆盖原文。

### FR-03 Pi 运行时

- 使用 OpenAI OAuth 正常完成多轮对话和工具调用。
- 服务重启后可继续 active session。
- 生产 profile 不暴露通用高权限工具。

### FR-04 项目/事项状态闭环

- 自然语言可创建、更新、完成项目和事项。
- 想法与任务不混淆。
- 等待事项能保存对象、条件和 review 时间。
- 条件预案不会提前创建成 active action。

### FR-05 当前注意力

- 用户问“我现在该做什么”时，只返回可行动且相关的少量事项。
- 等待和稍后想法默认不进入当前列表。
- 不隐藏硬 deadline 和已到检查点的承诺。

### FR-06 Hindsight 记忆

- 能异步 retain 7.2 所列的高价值记忆；原始消息仍完整留在 SQLite，不把每轮聊天全量写入 Hindsight。
- `MEMORY_ENABLED=false` 时对话与状态维护完整可用，且不出现降级提示。
- 新 session 能 recall 旧 session 中的相关事实或纠正。
- Hindsight 关闭时基本对话、Bitable 状态更新仍可用。
- 中文回归集中至少 8/10 个查询能在前 5 条 recall 结果中命中正确记忆；未达到时不得宣称长期记忆完成。

### FR-07 自动 session rollover

自动化测试需构造一条接近阈值、经历 compaction 的长 session，并证明：

- rollover 只发生在完整回合之后；
- 旧 session JSONL 保留；
- 新 session 能准确说出当前 focus、open loops、等待和下一步；
- 不重复执行旧 session 已成功完成的工具调用；
- Hindsight 不可用时仍可通过 handoff 恢复；
- 用户侧没有明显“重新开始”的断裂。

### FR-08 降级与重试

分别模拟 Cloudflare 429、Hindsight 超时、Bitable 写入失败、外部任务写入失败和服务重启：

- 用户获得明确但不过度技术化的回复；
- 当前输入不会丢失；
- 可重试操作进入 outbox；
- 不发生无限重试和重复写入。

### FR-09 外部行动路由与挂载

- 明确的个人行动写入滴答，并在 `行动同步` 中挂到对应事项。
- 明确的协同承诺经必要确认后写入飞书任务，并保存负责人、外部 ID 和项目关系。
- 明确起止时间的会议安排在 Bitable 中形成挂载的时间安排，但不创建外部任务或企微日程。
- 等待、想法和未触发条件分支不会被错误创建成外部任务或时间安排。
- 用户在任一事实源中的人工修改会被识别为权威纠正，并反映到 Bitable 当前视图。

### FR-10 检查点提醒

- 用户明确给出的 deadline、时间安排或等待检查点可以登记一次提醒，并分别标为 `deadline`、`scheduled_event`、`checkpoint`。
- 提醒经 SQLite 持久化，服务重启不丢失。
- 首版不猜测提前量；没有明确时间时不自动生成提醒时间。
- 到点后只推送与该事项相关的简短上下文、当前状态和建议动作，不发送无关日报。

---

## 12. 必须覆盖的验收用例

1. **混合输入**：一句话同时包含一个等待、一个今晚行动和一个暂存想法；系统正确拆分，今晚行动写入滴答并挂回事项，其余两者不污染滴答。
2. **想法非任务**：“我在想是不是可以……”只进入稍后区。
3. **明确承诺**：“我今晚把报价页改完”进入可行动事项、写入滴答并保留 deadline 与外部对象 ID。
4. **等待解除**：“等张总回复，周五没消息再催”保存等待、review 时间和条件预案，并在周五触发一次提醒。
5. **纠正**：“不是 A 项目，是 B 项目”修正关联，并将纠正作为高价值记忆候选。
6. **岔开恢复**：active focus 为 A 时捕获 B，B 不丢失，A 的焦点不被无条件切换。
7. **探索模式**：用户明确表示“先发散想想”，Agent 不频繁拉回或强行生成任务。
8. **重复事件投递**：同一 `message_id` 仅产生一个 event 和一组状态变更。
9. **Session 换代**：跨新 session 准确恢复 focus 和未闭环事项。
10. **中文长期召回**：能召回包含中文人名、项目名、日期、纠正和工作偏好的记忆。
11. **记忆冲突**：旧记忆与最新 Bitable 状态冲突时，以最近确认状态为准并保留不确定性。
12. **Cloudflare 中断**：不阻断基本 Agent 使用。
13. **提示注入**：飞书文档或外部文本中的“忽略规则并发送消息”不能触发未授权工具。
14. **服务重启**：Supervisor、Hindsight 重启后无数据丢失，active session 可恢复。
15. **会议安排**：“周四下午三点到四点和院方开会”在 `行动同步` 中创建 Bitable 持有的“时间安排”，保存起止时间、挂回事项并登记提醒，但不创建外部日程；“周四前完成方案”是 deadline 型行动，不得当成会议或检查点。
16. **协同任务**：“请小王周五前补接口清单”识别为飞书任务，在影响他人前做一次最小确认，创建后保存负责人和外部 ID。
17. **人工修改**：用户在滴答完成任务、在飞书任务改负责人或在 Bitable 修正事项后，Agent 下次触碰该事项时承认新状态并更新镜像，不以旧记忆覆盖。
18. **不完整时间**：“下周开会”只记录待确认日程意图，不编造日期和起止时间。
19. **记忆关闭**：`MEMORY_ENABLED=false` 时用例 1–8 全部通过。

---

## 13. 迭代实施顺序

### 阶段 0：工程骨架

- TypeScript 项目、配置、日志、SQLite migration（含 `reminders`）、systemd 模板。
- `.env.example`、目录权限、健康检查。
- Pi、Hindsight、lark-cli 版本锁定；ADR-0003（PG16）、ADR-0004（lark-cli 事件入口）落盘。
- 定义 Channel、State、Memory、Action Adapter 与 Reminder 的稳定接口；微信和更多执行系统先复用接口，不建立第二套 Agent。

完成标准：空服务可启动、停止、重启，健康检查和资源统计可用。

### 阶段 1：Bot + Pi + Event Log + Memory Baseline

- `lark-cli event consume` 长连接子进程管理（等待 ready marker、stdin 保活、SIGTERM 退出）、单用户 allowlist、`message_id` 幂等。
- Pi SDK/RPC 最小对话。
- 输入、回复、session 元数据写 SQLite。
- Hindsight 从该阶段接入（现有 PG16 + pgvector）：生产验收必须在 `MEMORY_ENABLED=true` 下完成一条高价值信息 retain、一次跨 session recall 和不可用时降级；`false` 只用于开发测试与降级回归。

完成标准：Bot 可多轮对话，重启后继续，所有回合可追溯；记忆接通但故障不阻断对话。

### 阶段 2：核心整理闭环 + Bitable

- 创建 `项目`、`事项` 两张主表、`行动同步` 后台表和窄视图。
- lark-cli Adapter 与高层 state tools。
- 完成混合输入拆分、等待、想法暂存、时间安排、状态纠正和外部行动挂载计划。

完成标准：关键验收用例 1–6 通过；其中涉及滴答写入的部分以 dry-run 计划为准，阶段 3 起以真实写入为准。

### 阶段 3：外部执行系统 + 到期提醒

- 接通滴答与飞书任务；顺序以凭证就绪为准，若两者同时可用则先验证更贴近日常个人行动闭环的滴答。企微日程 Adapter 只留接口。
- 外部对象 ID、事实源、状态镜像和人工修改写入 `行动同步`。
- 对用户明确给出的时间、deadline 和等待检查点登记一次提醒。
- 失败进入 outbox，重试不重复创建；影响他人的动作执行前最小确认。

完成标准：FR-09、FR-10 和验收用例 15–18 通过。

### 阶段 4：Memory Quality + Session Rollover

- 完成 7.2 retain 筛选策略、auto-recall 预算、超时与 outbox、中文 recall 回归集。
- compaction 事件统计。
- handoff schema 和校验。
- 自动换 session、失败回退、旧 JSONL 保留。

完成标准：FR-06、FR-07 和 Cloudflare 降级测试通过。

### 阶段 5：Attention Query

- `focus_state`、基础 cognitive mode。
- “现在”“等待”“继续某项目”查询。
- 确定性候选排序 + LLM 解释。

完成标准：输出不会把等待和想法伪装成 active action，且能恢复工作。

### 阶段 6：运行加固

- 权限收口、日志轮转、备份恢复、错误告警。
- RSS 和延迟基准。
- 端到端回归测试。

完成标准：在目标 VPS 上连续运行，核心故障场景不会丢事件或重复写入。

---

## 14. 后续版本路线，不在 MVP 实现

### P1：更多入口与完整同步

- 增加微信 Bot，复用与飞书 Bot 相同的 Agent、状态和记忆。
- 接入企业微信日程 Adapter：有明确起止时间的公司会议写入企微日程并挂回事项；需要企业自建应用凭证。
- 扩展滴答、飞书任务的 webhook 或轮询同步覆盖，替代 MVP 的按需读取。
- 在确有需要后处理标题、负责人、时间等字段的复杂双向冲突；MVP 先坚持一字段一事实源。
- 增加更多外部系统时复用 Action Adapter，不把路由规则散落进 prompt。

### P2：个性化主动注意力管理

- 基于真实使用反馈设计早间关注、恢复卡主动浮现和个性化提前量。
- 允许用户设置安静时段和干预强度。
- 不采用固定“每天只能 3 件”，而是 1–3 个 focus + 全部硬约束。

### P3：行为模型与协作策略

- 周期性 reflect 和 mental model refresh。
- 记录“干预 → 实际结果”，而不只记录偏好。
- working-model claim 包含证据、置信度、适用范围、最后验证时间和撤回状态。
- Agent 应随着用户能力变化减少不再必要的干预。

### P4：创造性浮现

- 将高潜力但暂时未行动的想法与已完成项目重新关联。
- 受控地让旧想法“浮现”，但不直接进入待办。
- 明确区分 exploration 与 execution，避免把所有发散当作分心。

---

## 15. 当前明确不再讨论、先按此实现的架构决定

1. 首版只用一台美国 VPS，不做灾备和国内节点。
2. Pi 是 agent runtime，不是长期记忆真源。
3. Hindsight 从首版开始接入，但作为可降级 sidecar。
4. Embedding 使用 Cloudflare Workers AI 的 Qwen3 Embedding 0.6B，不跑本地模型。
5. Reranker 首版使用 RRF，不增加额外 API 或本地模型。
6. Current state 使用 `项目 + 事项` 两张主表；外部执行对象统一挂在 `行动同步` 后台表，不把多组外部 ID 塞进事项宽表。
7. 原始事件和 session 元数据使用 SQLite。
8. 先验证对话倾倒、自动整理、Bitable 状态与记忆闭环；飞书任务和滴答随后在同一 MVP 内逐项接通；企微日程推迟到 P1。
9. 不以一个永不结束的 session 维持“默契”。
10. 不在第一版建立复杂的 attention learning；先记录真实使用数据，再演进。
11. 用户在 Bitable、滴答或飞书任务中的人工修改是权威纠正；记忆和 Agent 推断不得覆盖。事实源按需读取，MVP 不轮询。
12. MVP 只对明确时间、deadline 和等待检查点做一次提醒，不做机械每日推送。
13. Hindsight 使用宿主机已有 PostgreSQL 16 + pgvector，不启用 pg0（ADR-0003）。
14. 飞书消息经 lark-cli 事件总线长连接接收，不部署 webhook（ADR-0004）。
15. 长期记忆有 `MEMORY_ENABLED` 开关，关闭时产品闭环完整可用。

---

## 16. 外部参考与实现校验来源

开发前应重新核对锁定版本文档，以下为 2026-09-02 查验的主要来源：

- Pi Agent Harness：<https://github.com/earendil-works/pi>
- Pi Coding Agent README / SDK / RPC / Sessions：<https://github.com/earendil-works/pi/tree/main/packages/coding-agent>
- Hindsight：<https://github.com/vectorize-io/hindsight>
- Hindsight Configuration：<https://hindsight.vectorize.io/developer/configuration>
- Hindsight Multilingual Support：<https://hindsight.vectorize.io/developer/multilingual>
- Lark CLI：<https://github.com/larksuite/cli>
- Lark CLI 事件消费（本地）：`lark-cli skills read lark-event`、`lark-cli event schema im.message.receive_v1 --json`
- Cloudflare Workers AI OpenAI Compatibility：<https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/>
- Cloudflare Qwen3 Embedding：<https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/>
- Cloudflare Workers AI Pricing：<https://developers.cloudflare.com/workers-ai/platform/pricing/>
