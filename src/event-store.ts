import { DatabaseSync } from "node:sqlite";

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
  ): void;
  fail(sourceMessageId: string, errorMessage: string, updatedAt: string): void;
  get(sourceMessageId: string): StoredEvent | undefined;
  health(): EventStoreHealth;
  close(): void;
}

interface EventRow {
  source_message_id: string;
  user_id: string;
  raw_text: string;
  processing_status: string;
  assistant_reply: string | null;
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

    complete(sourceMessageId, parsedIntentJson, acknowledgement, updatedAt) {
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

    get,

    health() {
      return readStorageHealth(database);
    },

    close() {
      database.close();
    },
  };
}
