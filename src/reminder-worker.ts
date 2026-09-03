import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { ReminderKind } from "./state-operations.js";
import { initializeStorage } from "./storage.js";

export interface ReminderDelivery {
  readonly reminderKey: string;
  readonly idempotencyKey: string;
  readonly itemRecordId: string;
  readonly projectRecordId?: string;
  readonly fireAt: string;
  readonly kind: ReminderKind;
  readonly title: string;
  readonly context?: string;
  readonly suggestedAction?: string;
  readonly sourceEventId: string;
}

export interface ReminderNotifier {
  notify(delivery: ReminderDelivery): Promise<void>;
}

export interface ReminderWorkerOptions {
  readonly databasePath: string;
  readonly notifier: ReminderNotifier;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
}

export interface ReminderWorker {
  runOnce(now?: string): Promise<boolean>;
  close(): void;
}

interface DueReminderRow {
  id: string;
  item_record_id: string;
  project_record_id: string | null;
  fire_at: string;
  kind: ReminderKind;
  payload_json: string;
  source_event_id: string;
}

interface DeliveryRow {
  id: string;
  payload_json: string;
  attempt_count: number;
}

interface DeliveryPayload extends ReminderDelivery {
  readonly maxAttempts: number;
}

function deliveryIdempotencyKey(reminderKey: string): string {
  return `cas-reminder-${createHash("sha256")
    .update(reminderKey)
    .digest("hex")
    .slice(0, 32)}`;
}

function parseReminderPayload(value: string): {
  readonly title?: unknown;
  readonly context?: unknown;
  readonly suggestedAction?: unknown;
} {
  const payload = JSON.parse(value) as unknown;
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid reminder payload");
  }
  return payload;
}

function parseDeliveryPayload(value: string): DeliveryPayload {
  const payload = JSON.parse(value) as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("maxAttempts" in payload) ||
    typeof payload.maxAttempts !== "number" ||
    !("reminderKey" in payload) ||
    typeof payload.reminderKey !== "string" ||
    !("idempotencyKey" in payload) ||
    typeof payload.idempotencyKey !== "string" ||
    !("itemRecordId" in payload) ||
    typeof payload.itemRecordId !== "string" ||
    !("fireAt" in payload) ||
    typeof payload.fireAt !== "string" ||
    !("kind" in payload) ||
    !["checkpoint", "deadline", "scheduled_event"].includes(
      String(payload.kind),
    ) ||
    !("title" in payload) ||
    typeof payload.title !== "string" ||
    !("sourceEventId" in payload) ||
    typeof payload.sourceEventId !== "string"
  ) {
    throw new Error("Invalid reminder delivery payload");
  }
  return payload as DeliveryPayload;
}

export function createReminderWorker(
  options: ReminderWorkerOptions,
): ReminderWorker {
  const database = new DatabaseSync(options.databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const recoveredAt = new Date().toISOString();
  database
    .prepare(
      `UPDATE outbox
       SET status = 'retry', next_attempt_at = NULL,
           last_error_json = ?, updated_at = ?
       WHERE operation_type = 'reminder.deliver' AND status = 'running'`,
    )
    .run(
      JSON.stringify({ message: "Reminder delivery interrupted by service restart" }),
      recoveredAt,
    );

  const enqueueDue = (now: string): void => {
    const row = database
      .prepare(
        `SELECT id, item_record_id, project_record_id, fire_at, kind,
                payload_json, source_event_id
         FROM reminders r
         WHERE status = 'pending'
           AND julianday(fire_at) <= julianday(?)
           AND NOT EXISTS (
             SELECT 1 FROM outbox o
             WHERE o.idempotency_key = 'reminder.deliver:' || r.id
           )
         ORDER BY fire_at ASC, created_at ASC
         LIMIT 1`,
      )
      .get(now) as unknown as DueReminderRow | undefined;
    if (row === undefined) {
      return;
    }
    const reminderPayload = parseReminderPayload(row.payload_json);
    const title =
      typeof reminderPayload.title === "string" &&
      reminderPayload.title.trim().length > 0
        ? reminderPayload.title
        : row.id;
    const payload: DeliveryPayload = {
      maxAttempts,
      reminderKey: row.id,
      idempotencyKey: deliveryIdempotencyKey(row.id),
      itemRecordId: row.item_record_id,
      ...(row.project_record_id === null
        ? {}
        : { projectRecordId: row.project_record_id }),
      fireAt: row.fire_at,
      kind: row.kind,
      title,
      ...(typeof reminderPayload.context === "string"
        ? { context: reminderPayload.context }
        : {}),
      ...(typeof reminderPayload.suggestedAction === "string"
        ? { suggestedAction: reminderPayload.suggestedAction }
        : {}),
      sourceEventId: row.source_event_id,
    };
    database
      .prepare(
        `INSERT OR IGNORE INTO outbox (
          id, operation_type, idempotency_key, payload_json, status,
          attempt_count, next_attempt_at, last_error_json,
          created_at, updated_at
        ) VALUES (?, 'reminder.deliver', ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
      )
      .run(
        randomUUID(),
        `reminder.deliver:${row.id}`,
        JSON.stringify(payload),
        now,
        now,
      );
  };

  return {
    async runOnce(now = new Date().toISOString()) {
      enqueueDue(now);
      const row = database
        .prepare(
          `SELECT id, payload_json, attempt_count
           FROM outbox
           WHERE operation_type = 'reminder.deliver'
             AND status IN ('pending', 'retry')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(now) as unknown as DeliveryRow | undefined;
      if (row === undefined) {
        return false;
      }
      const claim = database
        .prepare(
          `UPDATE outbox
           SET status = 'running', updated_at = ?
           WHERE id = ? AND status IN ('pending', 'retry')`,
        )
        .run(now, row.id);
      if (claim.changes === 0) {
        return false;
      }

      let payload: DeliveryPayload | undefined;
      try {
        payload = parseDeliveryPayload(row.payload_json);
        await options.notifier.notify(payload);
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare(
              `UPDATE outbox
               SET status = 'succeeded', attempt_count = attempt_count + 1,
                   next_attempt_at = NULL, last_error_json = NULL, updated_at = ?
               WHERE id = ?`,
            )
            .run(now, row.id);
          database
            .prepare(
              `UPDATE reminders
               SET status = 'fired', fired_at = ?, updated_at = ?
               WHERE id = ? AND status = 'pending'`,
            )
            .run(now, now, payload.reminderKey);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        const attemptCount = row.attempt_count + 1;
        const allowedAttempts = payload?.maxAttempts ?? maxAttempts;
        const status = attemptCount >= allowedAttempts ? "dead" : "retry";
        const nextAttemptAt = new Date(
          Date.parse(now) + retryDelayMs * 2 ** Math.max(0, attemptCount - 1),
        ).toISOString();
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare(
              `UPDATE outbox
               SET status = ?, attempt_count = ?, next_attempt_at = ?,
                   last_error_json = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              status,
              attemptCount,
              status === "dead" ? null : nextAttemptAt,
              JSON.stringify({
                message: error instanceof Error ? error.message : String(error),
              }),
              now,
              row.id,
            );
          if (status === "dead" && payload !== undefined) {
            database
              .prepare(
                `UPDATE reminders
                 SET status = 'failed', updated_at = ?
                 WHERE id = ? AND status = 'pending'`,
              )
              .run(now, payload.reminderKey);
          }
          database.exec("COMMIT");
        } catch (transactionError) {
          database.exec("ROLLBACK");
          throw transactionError;
        }
      }
      return true;
    },

    close() {
      database.close();
    },
  };
}
