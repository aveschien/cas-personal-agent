import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  memoryOperationId,
  type MemoryCandidate,
  validateMemoryCandidate,
} from "./memory.js";
import { initializeStorage, readStorageHealth } from "./storage.js";

export interface NewEventRecord {
  readonly id: string;
  readonly source: "feishu";
  readonly sourceMessageId: string;
  readonly receivedAt: string;
  readonly userId: string;
  readonly rawText: string;
  readonly rawPayloadJson: string;
  readonly logicalConversationId: string;
  readonly createdAt: string;
}

export interface StoredEvent {
  readonly sourceMessageId: string;
  readonly userId: string;
  readonly rawText: string;
  readonly processingStatus: string;
  readonly acknowledgement: string | null;
}

export interface EventReceipt {
  readonly inserted: boolean;
  readonly event: StoredEvent;
}

export interface EventStoreHealth {
  readonly status: "ok" | "degraded";
  readonly journalMode: string;
  readonly schemaVersion: number;
}

export interface EventStore {
  receive(event: NewEventRecord): EventReceipt;
  complete(
    sourceMessageId: string,
    parsedIntentJson: string,
    acknowledgement: string,
    updatedAt: string,
    memoryRetentions?: readonly MemoryRetentionInput[],
  ): void;
  fail(sourceMessageId: string, errorMessage: string, updatedAt: string): void;
  deferProjection(
    sourceMessageId: string,
    parsedIntentJson: string,
    repairPayloadJson: string,
    errorMessage: string,
    updatedAt: string,
  ): void;
  get(sourceMessageId: string): StoredEvent | undefined;
  getRepair(sourceMessageId: string): StoredRepair | undefined;
  health(): EventStoreHealth;
  close(): void;
}

export interface MemoryRetentionInput {
  readonly candidate: MemoryCandidate;
  readonly occurredAt: string;
}

export interface StoredRepair {
  readonly operationType: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly payload: unknown;
  readonly lastError: string | null;
}

interface EventRow {
  source_message_id: string;
  user_id: string;
  raw_text: string;
  processing_status: string;
  assistant_reply: string | null;
}

interface RepairRow {
  operation_type: string;
  idempotency_key: string;
  status: string;
  attempt_count: number;
  payload_json: string;
  last_error_json: string | null;
}

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    sourceMessageId: row.source_message_id,
    userId: row.user_id,
    rawText: row.raw_text,
    processingStatus: row.processing_status,
    acknowledgement: row.assistant_reply,
  };
}

export function createEventStore(databasePath: string): EventStore {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);

  const get = (sourceMessageId: string): StoredEvent | undefined => {
    const row = database
      .prepare(
        `SELECT source_message_id, user_id, raw_text,
                processing_status, assistant_reply
         FROM events
         WHERE source_message_id = ?`,
      )
      .get(sourceMessageId) as unknown as EventRow | undefined;
    return row === undefined ? undefined : toStoredEvent(row);
  };
  const getRepair = (sourceMessageId: string): StoredRepair | undefined => {
    const row = database
      .prepare(
        `SELECT operation_type, idempotency_key, status, attempt_count,
                payload_json, last_error_json
         FROM outbox
         WHERE idempotency_key = ?`,
      )
      .get(`bitable.project:${sourceMessageId}`) as unknown as
      | RepairRow
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const payload = JSON.parse(row.payload_json) as {
      readonly maxAttempts?: unknown;
      readonly repair?: unknown;
    };
    const error =
      row.last_error_json === null
        ? undefined
        : (JSON.parse(row.last_error_json) as { readonly message?: unknown });
    return {
      operationType: row.operation_type,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      attemptCount: row.attempt_count,
      maxAttempts:
        typeof payload.maxAttempts === "number" ? payload.maxAttempts : 5,
      payload: payload.repair,
      lastError:
        error === undefined
          ? null
          : typeof error.message === "string"
            ? error.message
            : "Unknown error",
    };
  };

  return {
    receive(event) {
      const insertion = database
        .prepare(
          `INSERT OR IGNORE INTO events (
            id,
            source,
            source_message_id,
            received_at,
            user_id,
            raw_text,
            raw_payload_json,
            logical_conversation_id,
            processing_status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.source,
          event.sourceMessageId,
          event.receivedAt,
          event.userId,
          event.rawText,
          event.rawPayloadJson,
          event.logicalConversationId,
          "received",
          event.createdAt,
          event.createdAt,
        );
      const stored = get(event.sourceMessageId);
      if (stored === undefined) {
        throw new Error("Event could not be loaded after receipt");
      }
      return {
        inserted: insertion.changes > 0,
        event: stored,
      };
    },

    complete(
      sourceMessageId,
      parsedIntentJson,
      acknowledgement,
      updatedAt,
      memoryRetentions = [],
    ) {
      for (const retention of memoryRetentions) {
        validateMemoryCandidate(retention.candidate);
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `UPDATE events
             SET parsed_intent_json = ?,
                 assistant_reply = ?,
                 processing_status = 'completed',
                 updated_at = ?
             WHERE source_message_id = ?`,
          )
          .run(parsedIntentJson, acknowledgement, updatedAt, sourceMessageId);
        const insert = database.prepare(
          `INSERT OR IGNORE INTO outbox (
            id, operation_type, idempotency_key, payload_json, status,
            attempt_count, next_attempt_at, last_error_json,
            created_at, updated_at
          ) VALUES (?, 'memory.retain', ?, ?, 'pending', 0, ?, NULL, ?, ?)`,
        );
        for (const retention of memoryRetentions) {
          const idempotencyKey =
            `memory.retain:${sourceMessageId}:${retention.candidate.key}`;
          insert.run(
            randomUUID(),
            idempotencyKey,
            JSON.stringify({
              maxAttempts: 5,
              sourceEventId: sourceMessageId,
              occurredAt: retention.occurredAt,
              operationId: memoryOperationId(
                sourceMessageId,
                retention.candidate.key,
              ),
              candidate: retention.candidate,
            }),
            updatedAt,
            updatedAt,
            updatedAt,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    fail(sourceMessageId, errorMessage, updatedAt) {
      database
        .prepare(
          `UPDATE events
           SET processing_status = 'failed',
               error_json = ?,
               updated_at = ?
           WHERE source_message_id = ?`,
        )
        .run(JSON.stringify({ message: errorMessage }), updatedAt, sourceMessageId);
    },

    deferProjection(
      sourceMessageId,
      parsedIntentJson,
      repairPayloadJson,
      errorMessage,
      updatedAt,
    ) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `UPDATE events
             SET parsed_intent_json = ?,
                 processing_status = 'degraded',
                 error_json = ?,
                 updated_at = ?
             WHERE source_message_id = ?`,
          )
          .run(
            parsedIntentJson,
            JSON.stringify({ message: errorMessage }),
            updatedAt,
            sourceMessageId,
          );
        database
          .prepare(
            `INSERT INTO outbox (
              id, operation_type, idempotency_key, payload_json, status,
              attempt_count, next_attempt_at, last_error_json,
              created_at, updated_at
            ) VALUES (?, 'bitable.project', ?, ?, 'retry', 1, ?, ?, ?, ?)
            ON CONFLICT(idempotency_key) DO UPDATE SET
              payload_json = excluded.payload_json,
              status = 'retry',
              next_attempt_at = excluded.next_attempt_at,
              last_error_json = excluded.last_error_json,
              updated_at = excluded.updated_at`,
          )
          .run(
            randomUUID(),
            `bitable.project:${sourceMessageId}`,
            JSON.stringify({
              maxAttempts: 5,
              repair: JSON.parse(repairPayloadJson) as unknown,
            }),
            updatedAt,
            JSON.stringify({ message: errorMessage }),
            updatedAt,
            updatedAt,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    get,

    getRepair,

    health() {
      return readStorageHealth(database);
    },

    close() {
      database.close();
    },
  };
}
