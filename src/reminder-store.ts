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
      database
        .prepare(
          `INSERT INTO reminders (
            id, item_record_id, project_record_id, fire_at, kind, status, payload_json,
            source_event_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            item_record_id = excluded.item_record_id,
            project_record_id = excluded.project_record_id,
            fire_at = excluded.fire_at,
            kind = excluded.kind,
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
          reminder.key,
          itemRecordId,
          projectRecordId ?? null,
          reminder.fireAt,
          reminder.kind,
          JSON.stringify({
            itemKey: reminder.itemKey,
            ...(reminder.projectKey === undefined
              ? {}
              : { projectKey: reminder.projectKey }),
            title: reminder.title,
            ...(reminder.context === undefined
              ? {}
              : { context: reminder.context }),
            ...(reminder.suggestedAction === undefined
              ? {}
              : { suggestedAction: reminder.suggestedAction }),
          }),
          reminder.sourceEventId,
          now,
          now,
        );
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
