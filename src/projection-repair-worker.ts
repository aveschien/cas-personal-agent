import { DatabaseSync } from "node:sqlite";

import type { BitableStateProjector } from "./bitable-state-projector.js";
import {
  isSemanticOperation,
  type SemanticOperation,
} from "./state-operations.js";
import { initializeStorage } from "./storage.js";

export interface ProjectionRepairWorkerOptions {
  readonly databasePath: string;
  readonly projector: BitableStateProjector;
  readonly retryDelayMs?: number;
}

export interface ProjectionRepairWorker {
  runOnce(now?: string): Promise<boolean>;
  close(): void;
}

interface RepairRow {
  id: string;
  idempotency_key: string;
  payload_json: string;
  attempt_count: number;
  parsed_intent_json: string | null;
}

interface RepairPayload {
  readonly maxAttempts: number;
  readonly repair: {
    readonly sourceEventId: string;
    readonly occurredAt?: string;
    readonly changes: readonly SemanticOperation[];
  };
}

function parsePayload(payloadJson: string): RepairPayload {
  const value = JSON.parse(payloadJson) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("maxAttempts" in value) ||
    typeof value.maxAttempts !== "number" ||
    !("repair" in value) ||
    typeof value.repair !== "object" ||
    value.repair === null ||
    !("sourceEventId" in value.repair) ||
    typeof value.repair.sourceEventId !== "string" ||
    !("changes" in value.repair) ||
    !Array.isArray(value.repair.changes) ||
    !value.repair.changes.every(isSemanticOperation)
  ) {
    throw new Error("Invalid Bitable repair payload");
  }
  return value as RepairPayload;
}

function acknowledgement(parsedIntentJson: string | null): string | null {
  if (parsedIntentJson === null) {
    return null;
  }
  const value = JSON.parse(parsedIntentJson) as unknown;
  if (
    typeof value === "object" &&
    value !== null &&
    "acknowledgement" in value &&
    typeof value.acknowledgement === "string"
  ) {
    return value.acknowledgement;
  }
  return null;
}

export function createProjectionRepairWorker(
  options: ProjectionRepairWorkerOptions,
): ProjectionRepairWorker {
  const database = new DatabaseSync(options.databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);
  const retryDelayMs = options.retryDelayMs ?? 5_000;

  return {
    async runOnce(now = new Date().toISOString()) {
      const row = database
        .prepare(
          `SELECT o.id, o.idempotency_key, o.payload_json, o.attempt_count,
                  e.parsed_intent_json
           FROM outbox o
           LEFT JOIN events e
             ON o.idempotency_key = 'bitable.project:' || e.source_message_id
           WHERE o.operation_type = 'bitable.project'
             AND o.status IN ('pending', 'retry')
             AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
           ORDER BY o.created_at ASC
           LIMIT 1`,
        )
        .get(now) as unknown as RepairRow | undefined;
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

      let payload: RepairPayload | undefined;
      try {
        payload = parsePayload(row.payload_json);
        await options.projector.project({
          sourceEventId: payload.repair.sourceEventId,
          ...(payload.repair.occurredAt === undefined
            ? {}
            : { occurredAt: payload.repair.occurredAt }),
          operations: payload.repair.changes,
        });
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare(
              `UPDATE outbox
               SET status = 'succeeded',
                   attempt_count = attempt_count + 1,
                   next_attempt_at = NULL,
                   last_error_json = NULL,
                   updated_at = ?
               WHERE id = ?`,
            )
            .run(now, row.id);
          database
            .prepare(
              `UPDATE events
               SET processing_status = 'completed',
                   assistant_reply = COALESCE(?, assistant_reply),
                   error_json = NULL,
                   updated_at = ?
               WHERE source_message_id = ?`,
            )
            .run(
              acknowledgement(row.parsed_intent_json),
              now,
              payload.repair.sourceEventId,
            );
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        const attemptCount = row.attempt_count + 1;
        const maxAttempts = payload?.maxAttempts ?? 5;
        const status = attemptCount >= maxAttempts ? "dead" : "retry";
        const delay = retryDelayMs * 2 ** Math.max(0, attemptCount - 2);
        const nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
        database
          .prepare(
            `UPDATE outbox
             SET status = ?,
                 attempt_count = ?,
                 next_attempt_at = ?,
                 last_error_json = ?,
                 updated_at = ?
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
      }
      return true;
    },

    close() {
      database.close();
    },
  };
}
