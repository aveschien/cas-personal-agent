# CAS Personal Agent

单用户、私有部署的个人工作管理 Agent。开发入口提供确定性 NDJSON 闭环；真实入口通过受管的 `lark-cli` Event Channel 接收飞书私聊，由使用 `openai-codex/gpt-5.6-luna`、`max` 推理强度的持久化 Pi SDK 会话解释消息，并用 `lark-cli` 回复。所有原始 Event 会先写入 SQLite，再通过类型化语义操作投影到飞书多维表格。

所有用户表达和 Agent 生成的业务时间固定按 `Asia/Shanghai`（北京时间）解释与写入，不依赖 VPS 的系统时区。原始 Event 的接收时间仍以 UTC 保存，作为排序和幂等的机器时间。

## 本地运行

要求 Node.js 24.14 或更高的 24.x 版本。

```bash
npm install
npm run build
CAS_DATABASE_PATH=./var/cas-agent.sqlite \
CAS_ALLOWED_USER_IDS=dev-user \
npm start
```

进程从 stdin 读取一行一个 JSON 命令，并向 stdout 写回一行 JSON。健康检查：

```json
{"type":"health"}
```

开发模式 Channel Event 示例：

```json
{"type":"event","event":{"sourceMessageId":"message-1","receivedAt":"2026-09-02T17:30:00.000Z","userId":"dev-user","rawText":"把报价页改完","rawPayload":{"event_id":"delivery-1"}}}
```

开发入口使用确定性占位 Interpreter 和无写入 State Adapter，因此不需要飞书、Pi、Bitable 或 Hindsight 凭证。

## 真实飞书 + Pi 运行

先确认 bot 身份和 Pi OAuth 可用：

```bash
lark-cli auth status --json --verify
pi auth check --provider openai-codex --json
```

复制 `.env.example` 为 `.env`，配置获准使用 Bot 的飞书 `open_id` 和三个多维表格 ID，然后启动：

```bash
set -a
. ./.env
set +a
npm run build
npm run start:live
```

进程会等待 `lark-cli` 的精确 ready 标记，并在收到 SIGTERM/SIGINT 后优雅关闭事件流、Pi 会话和 SQLite。systemd 模板位于 `deploy/cas-personal-agent.service`。

无 root 权限的单用户 VPS 可安装用户级常驻服务；当前用户已开启 linger 时，退出 SSH 后仍会持续监听飞书：

```bash
mkdir -p ~/.config/systemd/user
install -m 0644 deploy/cas-personal-agent-user.service ~/.config/systemd/user/cas-personal-agent.service
systemctl --user daemon-reload
systemctl --user enable --now cas-personal-agent.service
systemctl --user status cas-personal-agent.service
```

当前开发 Base 是 [CAS Personal Agent](https://scnnyorf7h0o.feishu.cn/base/ALm5bispqak1uVsw4uwcJbYxnhe)，包含“项目”“事项”“行动同步”三张表。固定时间安排写成 Bitable 自有的日程事项；截止时间和检查点分别保留为行动截止与事项复查时间。个人行动默认只写入“行动同步”；显式启用滴答后会直接进入异步创建队列，无需二次确认。协同承诺同样默认只规划；显式启用飞书任务后，负责人唯一解析成功的明确行动会直接进入可靠创建队列。

真实飞书入口默认启用消息聚合：每条原始消息先持久化；连续消息在最后一条之后静默 8 秒再合并为一个 Pi 回合，最迟等待 30 秒。文字和随后发送的图片会作为同一批输入，只回复一次。需要立刻处理时，在新消息开头发送 `立即回答`、`现在回答`、`马上回答` 或 `/now`；指令后也可以继续跟正文。

只验证真实 Pi SDK、受控工具和多轮上下文，不连接飞书：

```bash
npm run verify:pi
```

验证真实 Base 的幂等投影和关联字段：

```bash
set -a
. ./.env
set +a
npm run verify:bitable
```

验证真实 Pi 对混合输入的语义拆分、可逆默认和最小澄清：

```bash
set -a
. ./.env
set +a
npm run verify:mixed
```

## Hindsight 长期记忆

生产配置默认启用记忆。每回合在 Pi 之前执行最多 5 条、800 token、2 秒超时的轻量 recall；失败会静默降级。Pi 只能提出明确纠正、长期偏好/边界、重要决定或项目变化、行动结果和 Handoff 等高价值候选。候选与 Event 完成在同一个 SQLite 事务中进入 outbox，随后用稳定的 Hindsight `operation_id` 异步 retain，最多尝试 5 次。原始消息仍只完整保存在 SQLite。

VPS 使用现有 PostgreSQL 16，不启用 pg0。一次性准备步骤：

```bash
uv tool install hindsight-api-slim==0.9.2
sudo -u postgres createuser --pwprompt hindsight
sudo -u postgres createdb --owner hindsight hindsight
sudo -u postgres psql --dbname hindsight --command 'CREATE EXTENSION IF NOT EXISTS vector;'
mkdir -p ./var/hindsight-codex
cp .env.hindsight.example .env.hindsight
chmod 600 .env.hindsight
```

在 `.env.hindsight` 中填写独立数据库密码、Cloudflare account ID 和最小权限 token；不要把真实凭据提交到 Git。Hindsight 使用独立的 Codex OAuth 目录，按当前 Codex CLI 完成一次设备授权：

```bash
CODEX_HOME="$PWD/var/hindsight-codex" codex login --device-auth
```

授权完成后安装并启动服务：

```bash
sudo install -m 0644 deploy/hindsight-api.service /etc/systemd/system/hindsight-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now hindsight-api.service
sudo systemctl status hindsight-api.service
```

单用户 VPS 也可以使用仓库内的用户级 unit；开启 linger 后无需保持登录，且不需要以 root 运行 Hindsight：

```bash
mkdir -p ~/.config/systemd/user
install -m 0644 deploy/hindsight-api-user.service ~/.config/systemd/user/hindsight-api.service
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now hindsight-api.service
```

该服务只绑定 `127.0.0.1:8888`，MCP 关闭，API 进程数固定为 1，并使用 Hindsight 默认的内置后台 worker；这个单实例原型不需要另起 `hindsight-worker` 服务。Ubuntu 24.04 自带的 pgvector 0.6 尚不支持 iterative scan，因此配置显式关闭该优化；升级到 pgvector 0.8 或更新版本后可重新启用。

验证真实 Pi 的高价值候选筛选，不连接 Hindsight：

```bash
npm run verify:memory-candidate
```

Hindsight ready 后，在隔离的 smoke bank 中执行一次真实异步 retain 与跨客户端 recall：

```bash
set -a
. ./.env
set +a
npm run verify:memory
```

## 个人行动与到期提醒

明确的个人行动、deadline、时间安排开始和等待检查点会分别生成独立的 Action Link 与一次性 Reminder。Reminder 使用 SQLite 持久化，以绝对时间轴判断是否到期；业务时间始终是 `Asia/Shanghai`，不会受 VPS 时区影响。到点后 Bot 发送一条与该事项相关的 Markdown 私聊，失败使用稳定幂等键进行有界重试，服务重启后继续。

滴答写入默认关闭。准备好个人 API Token 和目标清单 ID 后，在 `.env` 中显式配置：

```bash
TICKTICK_ENABLED=true
TICKTICK_API_TOKEN=replace_with_personal_api_token
TICKTICK_PROJECT_ID=replace_with_project_id
TICKTICK_BASE_URL=https://api.ticktick.com/open/v1
```

中国区滴答账户使用 `https://api.dida365.com/open/v1`。创建任务前 Adapter 会在目标清单内检查稳定幂等标记；进程在外部创建后、Bitable 回写前中断，也不会因此重复创建任务。外部对象 ID、最新状态和同步时间会回写“行动同步”。

SQLite Current State 保存项目、事项和行动挂载的本地可恢复读模型；Bitable 继续作为可编辑展示面，滴答和飞书任务继续拥有各自执行事实。普通回合只读本地状态，不再逐项远端读取。后台默认每 60 秒比较 Bitable 和已配置滴答清单；滴答使用一次 ProjectData 开放任务快照，整个连接器每轮最多 5 次请求（含快照），单请求 5 秒超时。可用 `CAS_EXTERNAL_SYNC_INTERVAL_MS`、`CAS_EXTERNAL_SYNC_REQUEST_BUDGET`、`CAS_EXTERNAL_SYNC_TIMEOUT_MS` 调整，因此冷数据最坏覆盖时间约为 `ceil(待核对对象数/(预算-1)) × 间隔`。

ProjectData 中缺失只表示“不在当前开放任务快照”，不会被直接判为完成或删除；本地先保留 `unknown`，再将该对象放入 SQLite 持久化核验队列。队列及连接器指纹、最近成功时间、退避状态均可跨重启恢复。只有外部指纹实际变化才回写“行动同步”。中国区 Dida365 仅复用已验证的 ProjectData/单任务接口；在真实账号完成契约验证前，不启用 TickTick 专有的 completed/filter 等扩展接口。

近期项目、事项和未闭环问题另以最多 12 条 Working Set 引用保存，可跨重启恢复，但不复制完整事实。Pi 可通过受控只读工具查询最多 10 条本地 Project/Item/Attention；普通讨论不访问外部系统，历史表达才检索有限 Hindsight 结果。明确要求最新或遇到 `unknown` 时只核验指定 Action；连接器空闲时本回合等候该次受限读取，否则持久化排队并明确返回尚未核实。

提醒的幂等范围是“提醒 key + 有效版本”。同 key 的检查点或 deadline 改期会取消旧投递并创建新版本；事项完成/放弃/归档或外部行动完成会取消相关提醒。发送前 Worker 再检查本地版本和当前完成状态；外部状态为 `unknown` 时先有界延期，不能拿旧镜像催办。

## 协同承诺与飞书任务

飞书任务写入默认关闭。确认 `lark-cli auth status --json --verify` 的用户身份具备 `task:task:read` 和 `task:task:write` 后，可显式启用：

```bash
FEISHU_TASK_ENABLED=true
```

启用后，Pi 只有一个额外的只读通讯录解析工具。负责人必须唯一解析为飞书 `open_id`；零结果或同名多结果只会要求澄清。对于明确的协同任务指令，确定性投影层会直接允许 `lark-cli task +create --as user` 创建，不再要求用户下一回合确认；普通陈述、转述、想法和未触发预案仍不会创建。稳定 client token、审计载荷、有界重试和重启恢复防止重复任务；成功后任务 GUID、链接、状态和同步时间回写“行动同步”。

## 验证

```bash
npm run typecheck
npm test
```
