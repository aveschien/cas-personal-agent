import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { ReminderProjectionSink } from "./bitable-state-projector.js";
import type { ReminderKind, ReminderProjection } from "./state-operations.js";
import { initializeStorage } from "./storage.js";

export interface StoredReminder {
  readonly key: string;
  readonly itemRecordId: string;
  readonly projectRecordId?: string;
  readonly fireAt: string;
  readonly kind: ReminderKind;
  readonly status: "pending" | "fired" | "cancelled" | "failed";
  readonly sourceEventId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ReminderStore extends ReminderProjectionSink {
  get(key: string): StoredReminder | undefined;
  cancelForItem(itemRecordId: string, reason: string, now?: string): void;
  close(): void;
}

interface ReminderRow {
  id: string;
  item_record_id: string;
  project_record_id: string | null;
  fire_at: string;
  kind: ReminderKind;
  status: "pending" | "fired" | "cancelled" | "failed";
  source_event_id: string;
  payload_json: string;
  version: number;
  schedule_fingerprint: string | null;
}

export function createReminderStore(databasePath: string): ReminderStore {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);

  return {
    async schedule(
      reminder: ReminderProjection,
      itemRecordId: string,
      projectRecordId?: string,
    ) {
      const now = new Date().toISOString();
      const payload = {
        itemKey: reminder.itemKey,
        ...(reminder.projectKey === undefined ? {} : { projectKey: reminder.projectKey }),
        title: reminder.title,
        ...(reminder.context === undefined ? {} : { context: reminder.context }),
        ...(reminder.suggestedAction === undefined ? {} : { suggestedAction: reminder.suggestedAction }),
      };
      const fingerprint = createHash("sha256").update(JSON.stringify({ fireAt: reminder.fireAt, kind: reminder.kind, itemRecordId, projectRecordId: projectRecordId ?? null, sourceEventId: reminder.sourceEventId, payload })).digest("hex");
      const current = database.prepare("SELECT fire_at, kind, source_event_id, version, schedule_fingerprint FROM reminders WHERE id = ?").get(reminder.key) as
        | { fire_at: string; kind: ReminderKind; source_event_id: string; version: number; schedule_fingerprint: string | null }
        | undefined;
      const changed = current !== undefined && (current.schedule_fingerprint === null
        ? current.fire_at !== reminder.fireAt || current.kind !== reminder.kind || current.source_event_id !== reminder.sourceEventId
        : current.schedule_fingerprint !== fingerprint);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(
          `INSERT INTO reminders (
            id, item_record_id, project_record_id, fire_at, kind, status, payload_json,
            source_event_id, fired_at, cancelled_at, version, schedule_fingerprint, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            item_record_id = excluded.item_record_id,
            project_record_id = excluded.project_record_id,
            fire_at = excluded.fire_at,
            kind = excluded.kind,
            status = CASE WHEN ? THEN 'pending' ELSE reminders.status END,
            fired_at = CASE WHEN ? THEN NULL ELSE reminders.fired_at END,
            cancelled_at = CASE WHEN ? THEN NULL ELSE reminders.cancelled_at END,
            version = CASE WHEN ? THEN reminders.version + 1 ELSE reminders.version END,
            schedule_fingerprint = excluded.schedule_fingerprint,
            payload_json = excluded.payload_json,
            source_event_id = excluded.source_event_id,
            updated_at = excluded.updated_at`,
        ).run(
          reminder.key,
          itemRecordId,
          projectRecordId ?? null,
          reminder.fireAt,
          reminder.kind,
          JSON.stringify(payload),
          reminder.sourceEventId,
          fingerprint,
          now,
          now,
          changed ? 1 : 0,
          changed ? 1 : 0,
          changed ? 1 : 0,
          changed ? 1 : 0,
        );
        if (changed) {
          database.prepare(
            `UPDATE outbox SET status = 'dead', next_attempt_at = NULL,
             last_error_json = ?, updated_at = ?
             WHERE operation_type = 'reminder.deliver' AND status IN ('pending', 'retry', 'running')
               AND (idempotency_key = ? OR idempotency_key LIKE ?)`,
          ).run(JSON.stringify({ message: "reminder schedule superseded" }), now, `reminder.deliver:${reminder.key}`, `reminder.deliver:${reminder.key}:%`);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    cancelForItem(itemRecordId, reason, now = new Date().toISOString()) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const keys = database.prepare("SELECT id FROM reminders WHERE item_record_id = ? AND status IN ('pending', 'failed')").all(itemRecordId) as unknown as { id: string }[];
        database.prepare(
          `UPDATE reminders SET status = 'cancelled', cancelled_at = ?, version = version + 1, updated_at = ?
           WHERE item_record_id = ? AND status IN ('pending', 'failed')`,
        ).run(now, now, itemRecordId);
        for (const { id } of keys) {
          database.prepare(
            `UPDATE outbox SET status = 'dead', next_attempt_at = NULL, last_error_json = ?, updated_at = ?
             WHERE operation_type = 'reminder.deliver' AND status IN ('pending', 'retry', 'running')
               AND (idempotency_key = ? OR idempotency_key LIKE ?)`,
          ).run(JSON.stringify({ message: reason }), now, `reminder.deliver:${id}`, `reminder.deliver:${id}:%`);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    get(key) {
      const row = database
        .prepare(
          `SELECT id, item_record_id, project_record_id, fire_at, kind, status,
                  source_event_id, payload_json
           FROM reminders
           WHERE id = ?`,
        )
        .get(key) as unknown as ReminderRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      return {
        key: row.id,
        itemRecordId: row.item_record_id,
        ...(row.project_record_id === null
          ? {}
          : { projectRecordId: row.project_record_id }),
        fireAt: row.fire_at,
        kind: row.kind,
        status: row.status,
        sourceEventId: row.source_event_id,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      };
    },

    close() {
      database.close();
    },
  };
}
