import { randomUUID } from "node:crypto";
import { initializeStorage, readStorageHealth } from "./storage.js";
import { DatabaseSync } from "node:sqlite";

export interface ChannelEvent {
  readonly sourceMessageId: string;
  readonly receivedAt: string;
  readonly userId: string;
  readonly rawText: string;
  readonly rawPayload: Readonly<Record<string, unknown>>;
}

export interface StateChange {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface Interpretation {
  readonly changes: readonly StateChange[];
  readonly acknowledgement: string;
}

export interface Interpreter {
  interpret(event: ChannelEvent): Promise<Interpretation>;
}

export interface StateAdapter {
  project(changes: readonly StateChange[]): Promise<void>;
}

export interface IngestResult {
  readonly status: "completed" | "duplicate" | "rejected";
  readonly acknowledgement: string;
}

export interface EventView {
  readonly sourceMessageId: string;
  readonly userId: string;
  readonly rawText: string;
  readonly processingStatus: string;
  readonly acknowledgement: string | null;
}

export interface AgentHealth {
  readonly status: "ok" | "degraded";
  readonly mode: "development";
  readonly storage: {
    readonly journalMode: string;
    readonly schemaVersion: number;
  };
}

export interface DevelopmentAgent {
  ingest(event: ChannelEvent): Promise<IngestResult>;
  getEvent(sourceMessageId: string): EventView | undefined;
  health(): AgentHealth;
  close(): void;
}

export interface DevelopmentAgentOptions {
  readonly databasePath: string;
  readonly allowedUserIds: readonly string[];
  readonly interpreter: Interpreter;
  readonly stateAdapter: StateAdapter;
}

interface EventRow {
  source_message_id: string;
  user_id: string;
  raw_text: string;
  processing_status: string;
  assistant_reply: string | null;
}

export function createDevelopmentAgent(
  options: DevelopmentAgentOptions,
): DevelopmentAgent {
  const database = new DatabaseSync(options.databasePath, {
    enableForeignKeyConstraints: true,
  });
  const allowedUserIds = new Set(options.allowedUserIds);

  initializeStorage(database);

  return {
    async ingest(event) {
      if (!allowedUserIds.has(event.userId)) {
        return {
          status: "rejected",
          acknowledgement: "这个 Bot 仅供已授权用户使用。",
        };
      }

      const now = new Date().toISOString();
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
          randomUUID(),
          "feishu",
          event.sourceMessageId,
          event.receivedAt,
          event.userId,
          event.rawText,
          JSON.stringify(event.rawPayload),
          "cas-main",
          "received",
          now,
          now,
        );

      if (insertion.changes === 0) {
        const existing = database
          .prepare(
            `SELECT assistant_reply FROM events WHERE source_message_id = ?`,
          )
          .get(event.sourceMessageId) as unknown as
          | { assistant_reply: string | null }
          | undefined;
        if (existing === undefined) {
          throw new Error("Duplicate Event could not be loaded");
        }

        return {
          status: "duplicate",
          acknowledgement:
            existing.assistant_reply ?? "这条消息已记录，正在处理。",
        };
      }

      let interpretation: Interpretation;
      try {
        interpretation = await options.interpreter.interpret(event);
        await options.stateAdapter.project(interpretation.changes);
      } catch (error) {
        database
          .prepare(
            `UPDATE events
             SET processing_status = 'failed',
                 error_json = ?,
                 updated_at = ?
             WHERE source_message_id = ?`,
          )
          .run(
            JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
            }),
            new Date().toISOString(),
            event.sourceMessageId,
          );
        throw error;
      }

      database
        .prepare(
          `UPDATE events
           SET parsed_intent_json = ?,
               assistant_reply = ?,
               processing_status = 'completed',
               updated_at = ?
           WHERE source_message_id = ?`,
        )
        .run(
          JSON.stringify(interpretation),
          interpretation.acknowledgement,
          new Date().toISOString(),
          event.sourceMessageId,
        );

      return {
        status: "completed",
        acknowledgement: interpretation.acknowledgement,
      };
    },

    getEvent(sourceMessageId) {
      const row = database
        .prepare(
          `SELECT source_message_id, user_id, raw_text,
                  processing_status, assistant_reply
           FROM events
           WHERE source_message_id = ?`,
        )
        .get(sourceMessageId) as unknown as EventRow | undefined;

      if (row === undefined) {
        return undefined;
      }

      return {
        sourceMessageId: row.source_message_id,
        userId: row.user_id,
        rawText: row.raw_text,
        processingStatus: row.processing_status,
        acknowledgement: row.assistant_reply,
      };
    },

    health() {
      const storage = readStorageHealth(database);
      return {
        status: storage.status,
        mode: "development",
        storage: {
          journalMode: storage.journalMode,
          schemaVersion: storage.schemaVersion,
        },
      };
    },

    close() {
      database.close();
    },
  };
}
