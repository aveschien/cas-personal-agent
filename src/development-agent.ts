import { randomUUID } from "node:crypto";

import { createEventStore, type StoredEvent } from "./event-store.js";

export interface ChannelEvent {
  readonly sourceMessageId: string;
  readonly receivedAt: string;
  readonly userId: string;
  readonly rawText: string;
  readonly rawPayload: Readonly<Record<string, unknown>>;
}

export type ItemType = "task" | "idea" | "question" | "decision" | "information";
export type ItemStatus =
  | "inbox"
  | "actionable"
  | "in_progress"
  | "waiting"
  | "scheduled"
  | "completed"
  | "abandoned"
  | "archived";

export interface ItemStateChange {
  readonly kind: "item";
  readonly title: string;
  readonly type: ItemType;
  readonly status: ItemStatus;
}

export interface ProjectStateChange {
  readonly kind: "project";
  readonly name: string;
  readonly status: "tracking" | "paused" | "finished";
  readonly goal?: string;
}

export type StateChange = ItemStateChange | ProjectStateChange;

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

export type EventView = StoredEvent;

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

export function createDevelopmentAgent(
  options: DevelopmentAgentOptions,
): DevelopmentAgent {
  const events = createEventStore(options.databasePath);
  const allowedUserIds = new Set(options.allowedUserIds);

  return {
    async ingest(event) {
      if (!allowedUserIds.has(event.userId)) {
        return {
          status: "rejected",
          acknowledgement: "这个 Bot 仅供已授权用户使用。",
        };
      }

      const now = new Date().toISOString();
      const receipt = events.receive({
        id: randomUUID(),
        source: "feishu",
        sourceMessageId: event.sourceMessageId,
        receivedAt: event.receivedAt,
        userId: event.userId,
        rawText: event.rawText,
        rawPayloadJson: JSON.stringify(event.rawPayload),
        logicalConversationId: "cas-main",
        createdAt: now,
      });
      if (!receipt.inserted) {
        return {
          status: "duplicate",
          acknowledgement:
            receipt.event.acknowledgement ?? "这条消息已记录，正在处理。",
        };
      }

      let interpretation: Interpretation;
      try {
        interpretation = await options.interpreter.interpret(event);
        await options.stateAdapter.project(interpretation.changes);
      } catch (error) {
        events.fail(
          event.sourceMessageId,
          error instanceof Error ? error.message : String(error),
          new Date().toISOString(),
        );
        throw error;
      }

      events.complete(
        event.sourceMessageId,
        JSON.stringify(interpretation),
        interpretation.acknowledgement,
        new Date().toISOString(),
      );
      return {
        status: "completed",
        acknowledgement: interpretation.acknowledgement,
      };
    },

    getEvent(sourceMessageId) {
      return events.get(sourceMessageId);
    },

    health() {
      const storage = events.health();
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
      events.close();
    },
  };
}
