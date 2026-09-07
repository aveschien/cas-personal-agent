import { DatabaseSync } from "node:sqlite";

import type { CurrentStateSnapshot } from "./current-state-store.js";
import type { SemanticOperation } from "./state-operations.js";
import { initializeStorage } from "./storage.js";

export interface WorkingSetEntry {
  readonly entityType: "project" | "item" | "question" | "entry_point";
  readonly entityKey: string;
  readonly label: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly mentionCount: number;
  readonly lastMentionedAt: string;
}

export interface WorkingSetStore {
  observeMessage(conversationId: string, message: string, state: CurrentStateSnapshot, now: string): void;
  observeOperations(conversationId: string, operations: readonly SemanticOperation[], now: string): void;
  snapshot(conversationId: string, limit?: number): readonly WorkingSetEntry[];
  referenceCandidates(conversationId: string, message: string, limit?: number): readonly WorkingSetEntry[];
  close(): void;
}

interface Row {
  entity_type: WorkingSetEntry["entityType"];
  entity_key: string;
  label: string;
  payload_json: string;
  mention_count: number;
  last_mentioned_at: string;
}

export function createWorkingSetStore(databasePath: string, capacity = 12): WorkingSetStore {
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  initializeStorage(database);
  const touch = (conversationId: string, type: WorkingSetEntry["entityType"], key: string, label: string, payload: unknown, now: string) => {
    database.prepare(
      `INSERT INTO working_set_entries
       (logical_conversation_id, entity_type, entity_key, label, payload_json, status, mention_count, last_mentioned_at)
       VALUES (?, ?, ?, ?, ?, 'open', 1, ?)
       ON CONFLICT(logical_conversation_id, entity_type, entity_key) DO UPDATE SET
         label = excluded.label, payload_json = excluded.payload_json, status = 'open',
         mention_count = working_set_entries.mention_count + 1,
         last_mentioned_at = excluded.last_mentioned_at`,
    ).run(conversationId, type, key, label, JSON.stringify(payload), now);
    database.prepare(
      `DELETE FROM working_set_entries WHERE logical_conversation_id = ? AND rowid IN (
         SELECT rowid FROM working_set_entries WHERE logical_conversation_id = ?
         ORDER BY status = 'open' DESC, last_mentioned_at DESC LIMIT -1 OFFSET ?
       )`,
    ).run(conversationId, conversationId, capacity);
  };
  return {
    observeMessage(conversationId, message, state, now) {
      const normalized = message.toLocaleLowerCase("zh-CN");
      for (const project of state.projects) {
        if (normalized.includes(project.name.toLocaleLowerCase("zh-CN")) || normalized.includes(project.key.toLocaleLowerCase("zh-CN"))) {
          touch(conversationId, "project", project.key, project.name, { status: project.status, summary: project.summary ?? null }, now);
        }
      }
      for (const item of state.items) {
        if (normalized.includes(item.title.toLocaleLowerCase("zh-CN")) || normalized.includes(item.key.toLocaleLowerCase("zh-CN"))) {
          touch(conversationId, "item", item.key, item.title, { status: item.status, projectKey: item.projectKey ?? null, nextAction: item.nextAction ?? null }, now);
        }
      }
    },
    observeOperations(conversationId, operations, now) {
      for (const operation of operations) {
        if (operation.kind === "upsert_project") touch(conversationId, "project", operation.projectKey, operation.name, operation, now);
        if (operation.kind === "upsert_item" || operation.kind === "park_idea") touch(conversationId, "item", operation.itemKey, operation.title, operation, now);
        if (operation.kind === "upsert_item" && typeof operation.nextAction === "string") {
          touch(conversationId, "entry_point", `entry:${operation.itemKey}`, operation.nextAction, { itemKey: operation.itemKey }, now);
        }
        if (operation.kind === "clarify") touch(conversationId, "question", `question:${now}`, operation.question, { reason: operation.reason }, now);
      }
    },
    snapshot(conversationId, limit = capacity) {
      const rows = database.prepare(
        `SELECT entity_type, entity_key, label, payload_json, mention_count, last_mentioned_at
         FROM working_set_entries WHERE logical_conversation_id = ? AND status = 'open'
         ORDER BY last_mentioned_at DESC, mention_count DESC LIMIT ?`,
      ).all(conversationId, Math.min(limit, capacity)) as unknown as Row[];
      return rows.map((row) => ({ entityType: row.entity_type, entityKey: row.entity_key, label: row.label,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>, mentionCount: row.mention_count, lastMentionedAt: row.last_mentioned_at }));
    },
    referenceCandidates(conversationId, message, limit = 3) {
      const recent = this.snapshot(conversationId, capacity).filter((entry) => entry.entityType === "project" || entry.entityType === "item");
      const compact = message.replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
      if (/那个|这个|刚才|上次|先放着|接着|继续/.test(compact)) return recent.slice(0, limit);
      const matched = recent.filter((entry) => compact.includes(entry.label.toLocaleLowerCase("zh-CN")) || entry.label.toLocaleLowerCase("zh-CN").includes(compact));
      return matched.slice(0, limit);
    },
    close() { database.close(); },
  };
}
