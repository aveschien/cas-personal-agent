import { randomUUID } from "node:crypto";

import {
  createEventStore,
  type EventSource,
  type StoredEvent,
  type StoredRepair,
} from "./event-store.js";
import type {
  ItemStatus,
  ItemType,
  SemanticOperation,
} from "./state-operations.js";
import type { MemoryCandidate } from "./memory.js";
import { validateMemoryCandidate } from "./memory.js";
import type { PromptImage } from "./prompt-image.js";

export type { ItemStatus, ItemType } from "./state-operations.js";

export interface ChannelEvent {
  readonly sourceMessageId: string;
  readonly receivedAt: string;
  readonly userId: string;
  readonly rawText: string;
  readonly rawPayload: Readonly<Record<string, unknown>>;
  readonly images?: readonly PromptImage[];
  readonly source?: EventSource;
}

export function resolveEventSource(event: ChannelEvent): EventSource {
  if (event.source === "grok" || event.source === "feishu") {
    return event.source;
  }
  return event.rawPayload.channel === "grok" ? "grok" : "feishu";
}

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

export type StateChange =
  | ItemStateChange
  | ProjectStateChange
  | SemanticOperation;

export interface Interpretation {
  readonly changes: readonly StateChange[];
  readonly acknowledgement: string;
  readonly memoryCandidates?: readonly MemoryCandidate[];
}

export interface Interpreter {
  interpret(event: ChannelEvent): Promise<Interpretation>;
}

export interface StateAdapter {
  project(
    changes: readonly StateChange[],
    context: StateProjectionContext,
  ): Promise<void>;
}

export interface StateProjectionContext {
  readonly sourceEventId: string;
  readonly receivedAt: string;
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
  getRepair(sourceMessageId: string): StoredRepair | undefined;
  health(): AgentHealth;
  close(): void;
}

export interface DevelopmentAgentOptions {
  readonly databasePath: string;
  readonly allowedUserIds: readonly string[];
  readonly interpreter: Interpreter;
  readonly stateAdapter: StateAdapter;
  readonly memoryRetentionEnabled?: boolean;
  readonly onBackgroundError?: (error: unknown) => void;
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
        source: resolveEventSource(event),
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
      } catch (error) {
        events.fail(
          event.sourceMessageId,
          error instanceof Error ? error.message : String(error),
          new Date().toISOString(),
        );
        throw error;
      }

      try {
        await options.stateAdapter.project(interpretation.changes, {
          sourceEventId: event.sourceMessageId,
          receivedAt: event.receivedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.deferProjection(
          event.sourceMessageId,
          JSON.stringify(interpretation),
          JSON.stringify({
            sourceEventId: event.sourceMessageId,
            occurredAt: event.receivedAt,
            changes: interpretation.changes,
          }),
          message,
          new Date().toISOString(),
        );
        throw error;
      }

      const memoryRetentions =
        options.memoryRetentionEnabled === true
          ? (interpretation.memoryCandidates ?? []).flatMap((candidate) => {
              try {
                validateMemoryCandidate(candidate);
                return [{ candidate, occurredAt: event.receivedAt }];
              } catch (error) {
                options.onBackgroundError?.(error);
                return [];
              }
            })
          : [];
      events.complete(
        event.sourceMessageId,
        JSON.stringify(interpretation),
        interpretation.acknowledgement,
        new Date().toISOString(),
        memoryRetentions,
      );
      return {
        status: "completed",
        acknowledgement: interpretation.acknowledgement,
      };
    },

    getEvent(sourceMessageId) {
      return events.get(sourceMessageId);
    },

    getRepair(sourceMessageId) {
      return events.getRepair(sourceMessageId);
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
