# Hindsight 使用宿主机已有的 PostgreSQL 16，不启用 pg0

PRD v0.1 冻结的是 Hindsight 默认的 pg0 嵌入式数据库，理由是“不额外部署 PostgreSQL”。但目标 VPS（4C/3.8G）上已经在跑 PostgreSQL 16，再起一个嵌入式 PG 等于双份进程和内存。决定：为 Hindsight 在现有 PG16 上建独立 `hindsight` 库和角色，安装 `pgvector` 扩展，`HINDSIGHT_API_DATABASE_URL` 指向 `127.0.0.1:5432`。既有的 `brain`、`memu` 等库不动。

## 后果

- Hindsight 升级时要核对其对 PG 与 pgvector 版本的要求，不能再靠 pg0 自带的版本组合。
- 中文 BM25 的限制（PRD 4.2）不变；若将来评估 PGroonga/ParadeDB，是在这个实例上加扩展，不是换实例。
