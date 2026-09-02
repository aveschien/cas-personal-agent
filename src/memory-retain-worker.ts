import { DatabaseSync } from "node:sqlite";

import type { MemoryAdapter, MemoryCandidate } from "./memory.js";
import { initializeStorage } from "./storage.js";

export interface MemoryRetainWorkerOptions {
  readonly databasePath: string;
  readonly memory: MemoryAdapter;
  readonly retryDelayMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface MemoryRetainWorker {
  runOnce(now?: string): Promise<boolean>;
  close(): void;
}

interface RetainRow {
  id: string;
  payload_json: string;
  attempt_count: number;
}

interface RetainPayload {
  readonly maxAttempts: number;
  readonly sourceEventId: string;
  readonly occurredAt: string;
  readonly operationId: string;
  readonly candidate: MemoryCandidate;
}

function parsePayload(value: string): RetainPayload {
  const payload = JSON.parse(value) as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("maxAttempts" in payload) ||
    typeof payload.maxAttempts !== "number" ||
    !("sourceEventId" in payload) ||
    typeof payload.sourceEventId !== "string" ||
    !("occurredAt" in payload) ||
    typeof payload.occurredAt !== "string" ||
    !("operationId" in payload) ||
    typeof payload.operationId !== "string" ||
    !("candidate" in payload) ||
    typeof payload.candidate !== "object" ||
    payload.candidate === null
  ) {
    throw new Error("Invalid memory retain payload");
  }
  return payload as RetainPayload;
}

function statusCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return undefined;
}

export function createMemoryRetainWorker(
  options: MemoryRetainWorkerOptions,
): MemoryRetainWorker {
  const database = new DatabaseSync(options.databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const recoveredAt = new Date().toISOString();
  database
    .prepare(
      `UPDATE outbox
       SET status = 'retry',
           next_attempt_at = NULL,
           last_error_json = ?,
           updated_at = ?
       WHERE operation_type = 'memory.retain' AND status = 'running'`,
    )
    .run(
      JSON.stringify({ message: "Memory retain interrupted by service restart" }),
      recoveredAt,
    );

  return {
    async runOnce(now = new Date().toISOString()) {
      const row = database
        .prepare(
          `SELECT id, payload_json, attempt_count
           FROM outbox
           WHERE operation_type = 'memory.retain'
             AND status IN ('pending', 'retry')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(now) as unknown as RetainRow | undefined;
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

      let payload: RetainPayload | undefined;
      try {
        payload = parsePayload(row.payload_json);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          await options.memory.retain({
            candidate: payload.candidate,
            sourceEventId: payload.sourceEventId,
            occurredAt: payload.occurredAt,
            operationId: payload.operationId,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
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
      } catch (error) {
        const attemptCount = row.attempt_count + 1;
        const maxAttempts = payload?.maxAttempts ?? 5;
        const status = attemptCount >= maxAttempts ? "dead" : "retry";
        const delay =
          statusCode(error) === 429
            ? 24 * 60 * 60 * 1_000
            : retryDelayMs * 2 ** Math.max(0, attemptCount - 1);
        const nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
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
              ...(statusCode(error) === undefined
                ? {}
                : { statusCode: statusCode(error) }),
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
