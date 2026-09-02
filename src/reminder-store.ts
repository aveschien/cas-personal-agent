import { DatabaseSync } from "node:sqlite";

import type { ReminderProjectionSink } from "./bitable-state-projector.js";
import type { CheckpointProjection } from "./state-operations.js";
import { initializeStorage } from "./storage.js";

export interface StoredReminder {
  readonly key: string;
  readonly itemRecordId: string;
  readonly fireAt: string;
  readonly kind: "checkpoint";
  readonly status: "pending" | "fired" | "cancelled" | "failed";
  readonly sourceEventId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ReminderStore extends ReminderProjectionSink {
  get(key: string): StoredReminder | undefined;
  close(): void;
}

interface ReminderRow {
  id: string;
  item_record_id: string;
  fire_at: string;
  kind: "checkpoint";
  status: "pending" | "fired" | "cancelled" | "failed";
  source_event_id: string;
  payload_json: string;
}

export function createReminderStore(databasePath: string): ReminderStore {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);

  return {
    async schedule(checkpoint: CheckpointProjection, itemRecordId: string) {
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO reminders (
            id, item_record_id, fire_at, kind, status, payload_json,
            source_event_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'checkpoint', 'pending', ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            item_record_id = excluded.item_record_id,
            fire_at = excluded.fire_at,
            status = CASE
              WHEN reminders.status IN ('fired', 'cancelled')
                THEN reminders.status
              ELSE 'pending'
            END,
            payload_json = excluded.payload_json,
            source_event_id = excluded.source_event_id,
            updated_at = excluded.updated_at`,
        )
        .run(
          checkpoint.key,
          itemRecordId,
          checkpoint.fireAt,
          JSON.stringify({ itemKey: checkpoint.itemKey }),
          checkpoint.sourceEventId,
          now,
          now,
        );
    },

    get(key) {
      const row = database
        .prepare(
          `SELECT id, item_record_id, fire_at, kind, status,
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
