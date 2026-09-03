import type { DatabaseSync } from "node:sqlite";

const schemaVersion = 3;
const requiredTables = [
  "bitable_authoritative_corrections",
  "bitable_projection_snapshots",
  "events",
  "focus_state",
  "message_inbox",
  "outbox",
  "pi_sessions",
  "reminders",
  "schema_migrations",
  "session_handoffs",
] as const;

interface JournalModeRow {
  journal_mode: string;
}

interface SchemaVersionRow {
  user_version: number;
}

interface TableNameRow {
  name: string;
}

export interface StorageHealth {
  readonly status: "ok" | "degraded";
  readonly journalMode: string;
  readonly schemaVersion: number;
}

export function initializeStorage(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_message_id TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL,
      user_id TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      logical_conversation_id TEXT NOT NULL,
      pi_session_id TEXT,
      parsed_intent_json TEXT,
      related_project_ids_json TEXT,
      related_item_ids_json TEXT,
      assistant_reply TEXT,
      processing_status TEXT NOT NULL CHECK (
        processing_status IN ('received', 'processing', 'completed', 'degraded', 'failed')
      ),
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pi_sessions (
      id TEXT PRIMARY KEY,
      logical_conversation_id TEXT NOT NULL,
      pi_session_id TEXT NOT NULL UNIQUE,
      pi_session_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('active', 'retiring', 'retired', 'failed')
      ),
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      retired_at TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      estimated_context_tokens INTEGER NOT NULL DEFAULT 0,
      compaction_count INTEGER NOT NULL DEFAULT 0,
      handoff_id TEXT,
      rollover_reason TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_handoffs (
      id TEXT PRIMARY KEY,
      from_pi_session_id TEXT NOT NULL,
      to_pi_session_id TEXT,
      created_at TEXT NOT NULL,
      current_focus_json TEXT NOT NULL,
      confirmed_facts_json TEXT NOT NULL,
      open_loops_json TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      uncertainties_json TEXT NOT NULL,
      do_not_repeat_json TEXT NOT NULL,
      next_entry_point TEXT NOT NULL,
      reference_ids_json TEXT NOT NULL,
      source_event_range_json TEXT NOT NULL,
      validation_status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS focus_state (
      logical_conversation_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (
        mode IN ('explore', 'structure', 'decide', 'execute', 'recover', 'reflect', 'unknown')
      ),
      active_project_id TEXT,
      active_item_id TEXT,
      focus_started_at TEXT,
      last_confirmed_at TEXT,
      parking_lot_count INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS message_inbox (
      source_message_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      chat_type TEXT NOT NULL CHECK (chat_type IN ('p2p', 'group')),
      message_type TEXT NOT NULL,
      sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'bot')),
      raw_text TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'processing', 'completed', 'failed')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS message_inbox_pending_idx
      ON message_inbox (status, received_at);

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'succeeded', 'retry', 'dead')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      item_record_id TEXT NOT NULL,
      project_record_id TEXT,
      fire_at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (
        kind IN ('checkpoint', 'deadline', 'scheduled_event')
      ),
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'fired', 'cancelled', 'failed')
      ),
      payload_json TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      fired_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS bitable_projection_snapshots (
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      stable_key TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      projected_at TEXT NOT NULL,
      PRIMARY KEY (table_id, stable_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS bitable_authoritative_corrections (
      fingerprint TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      stable_key TEXT NOT NULL,
      changed_fields_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    ) STRICT;

    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (${schemaVersion}, CURRENT_TIMESTAMP);

    PRAGMA user_version = ${schemaVersion};
  `);
}

export function readStorageHealth(database: DatabaseSync): StorageHealth {
  const journal = database.prepare("PRAGMA journal_mode").get() as unknown as
    | JournalModeRow
    | undefined;
  const version = database.prepare("PRAGMA user_version").get() as unknown as
    | SchemaVersionRow
    | undefined;
  const placeholders = requiredTables.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name IN (${placeholders})`,
    )
    .all(...requiredTables) as unknown as TableNameRow[];

  const availableTables = new Set(rows.map((row) => row.name));
  const hasRequiredSchema = requiredTables.every((table) =>
    availableTables.has(table),
  );
  const journalMode = journal?.journal_mode.toLowerCase() ?? "unknown";
  const currentSchemaVersion = version?.user_version ?? 0;

  return {
    status:
      journalMode === "wal" &&
      currentSchemaVersion === schemaVersion &&
      hasRequiredSchema
        ? "ok"
        : "degraded",
    journalMode,
    schemaVersion: currentSchemaVersion,
  };
}
