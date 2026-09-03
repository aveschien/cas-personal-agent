import { DatabaseSync } from "node:sqlite";

import type { DevelopmentAgent } from "./development-agent.js";
import type {
  IncomingChannelMessage,
  LarkEventChannel,
} from "./lark-event-channel.js";
import type { MessageImageLoader } from "./lark-message-images.js";
import type { ReplyAdapter } from "./lark-reply-adapter.js";
import { initializeStorage } from "./storage.js";

export interface MessageBatcher {
  accept(message: IncomingChannelMessage): Promise<void>;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export interface MessageBatcherOptions {
  readonly databasePath: string;
  readonly allowedUserIds: readonly string[];
  readonly agent: Pick<DevelopmentAgent, "ingest">;
  readonly replies: ReplyAdapter;
  readonly images: MessageImageLoader;
  readonly settleMs?: number;
  readonly maxWaitMs?: number;
  readonly onError?: (error: unknown) => void;
}

interface InboxRow {
  source_message_id: string;
  batch_id: string;
  user_id: string;
  received_at: string;
  chat_type: "p2p" | "group";
  message_type: string;
  sender_type: "user" | "bot";
  raw_text: string;
  raw_payload_json: string;
}

interface PendingBatch {
  readonly id: string;
  readonly userId: string;
  readonly messages: IncomingChannelMessage[];
  settleTimer: NodeJS.Timeout | undefined;
  maxTimer: NodeJS.Timeout | undefined;
}

const immediatePattern = /^(?:\/now\b|立即回答|现在回答|马上回答)(?:[\s：:]*)/iu;

function stripImmediateDirective(text: string): {
  readonly immediate: boolean;
  readonly text: string;
} {
  const match = immediatePattern.exec(text.trim());
  if (match === null) {
    return { immediate: false, text };
  }
  return { immediate: true, text: text.trim().slice(match[0].length).trim() };
}

function toMessage(row: InboxRow): IncomingChannelMessage {
  const payload = JSON.parse(row.raw_payload_json) as unknown;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Message inbox contains an invalid raw payload");
  }
  return {
    event: {
      sourceMessageId: row.source_message_id,
      receivedAt: row.received_at,
      userId: row.user_id,
      rawText: row.raw_text,
      rawPayload: payload as Readonly<Record<string, unknown>>,
    },
    chatType: row.chat_type,
    messageType: row.message_type,
    senderType: row.sender_type,
  };
}

function batchText(messages: readonly IncomingChannelMessage[]): string {
  const parts = messages.flatMap((message, index) => {
    const directive = stripImmediateDirective(message.event.rawText);
    const content =
      message.messageType === "image"
        ? "[图片已附加，请结合图片内容理解]"
        : directive.text;
    if (content.length === 0) {
      return [];
    }
    return [`[消息 ${index + 1}/${messages.length} · ${message.messageType}]\n${content}`];
  });
  return parts.length === 0
    ? "请结合以上附件或前序消息立即回答。"
    : parts.join("\n\n");
}

function replyKey(messageId: string): string {
  return `reply-${messageId}`.slice(0, 50);
}

export function createMessageBatcher(
  options: MessageBatcherOptions,
): MessageBatcher {
  const database = new DatabaseSync(options.databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);
  database
    .prepare(
      `UPDATE message_inbox
       SET status = 'pending', updated_at = ?
       WHERE status = 'processing'`,
    )
    .run(new Date().toISOString());
  const allowedUserIds = new Set(options.allowedUserIds);
  const settleMs = options.settleMs ?? 8_000;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  if (settleMs <= 0 || maxWaitMs < settleMs) {
    database.close();
    throw new Error("Message batching requires 0 < settleMs <= maxWaitMs");
  }
  const batches = new Map<string, PendingBatch>();
  const activeBatchByUser = new Map<string, string>();
  let stopped = false;
  let processing = Promise.resolve();

  const clearTimers = (batch: PendingBatch): void => {
    if (batch.settleTimer !== undefined) {
      clearTimeout(batch.settleTimer);
    }
    if (batch.maxTimer !== undefined) {
      clearTimeout(batch.maxTimer);
    }
    batch.settleTimer = undefined;
    batch.maxTimer = undefined;
  };

  const processBatch = async (batch: PendingBatch): Promise<void> => {
    const ids = batch.messages.map((message) => message.event.sourceMessageId);
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(", ");
    database
      .prepare(
        `UPDATE message_inbox SET status = 'processing', updated_at = ?
         WHERE source_message_id IN (${placeholders})`,
      )
      .run(now, ...ids);
    let agentCompleted = false;
    try {
      const promptImages = await options.images.load(batch.messages);
      const first = batch.messages[0]!;
      const last = batch.messages[batch.messages.length - 1]!;
      const result = await options.agent.ingest({
        sourceMessageId: `batch:${batch.id}`,
        receivedAt: last.event.receivedAt,
        userId: batch.userId,
        rawText: batchText(batch.messages),
        rawPayload: {
          sourceMessageIds: ids,
          messageTypes: batch.messages.map((message) => message.messageType),
          firstReceivedAt: first.event.receivedAt,
          lastReceivedAt: last.event.receivedAt,
        },
        ...(promptImages.length === 0 ? {} : { images: promptImages }),
      });
      agentCompleted = true;
      await options.replies.reply({
        messageId: last.event.sourceMessageId,
        text: result.acknowledgement,
        idempotencyKey: replyKey(last.event.sourceMessageId),
      });
      database
        .prepare(
          `UPDATE message_inbox SET status = 'completed', updated_at = ?
           WHERE source_message_id IN (${placeholders})`,
        )
        .run(new Date().toISOString(), ...ids);
    } catch (error) {
      database
        .prepare(
          `UPDATE message_inbox SET status = ?, updated_at = ?
           WHERE source_message_id IN (${placeholders})`,
        )
        .run(
          agentCompleted ? "pending" : "failed",
          new Date().toISOString(),
          ...ids,
        );
      options.onError?.(error);
      if (agentCompleted && !stopped) {
        batches.set(batch.id, batch);
        schedule(batch);
      } else {
        const last = batch.messages[batch.messages.length - 1]!;
        try {
          await options.replies.reply({
            messageId: last.event.sourceMessageId,
            text: "消息已完整收到，但这批内容暂时没有处理成功，请重新发送相关内容。",
            idempotencyKey: replyKey(last.event.sourceMessageId),
          });
        } catch (replyError) {
          options.onError?.(replyError);
        }
      }
    }
  };

  const enqueueFlush = (batchId: string): Promise<void> => {
    const batch = batches.get(batchId);
    if (batch === undefined) {
      return processing;
    }
    batches.delete(batchId);
    if (activeBatchByUser.get(batch.userId) === batchId) {
      activeBatchByUser.delete(batch.userId);
    }
    clearTimers(batch);
    processing = processing
      .catch((error: unknown) => options.onError?.(error))
      .then(() => processBatch(batch));
    return processing;
  };

  const schedule = (batch: PendingBatch, recovered = false): void => {
    if (batch.settleTimer !== undefined) {
      clearTimeout(batch.settleTimer);
    }
    batch.settleTimer = setTimeout(
      () => void enqueueFlush(batch.id),
      recovered ? 0 : settleMs,
    );
    batch.settleTimer.unref();
    if (batch.maxTimer === undefined) {
      batch.maxTimer = setTimeout(
        () => void enqueueFlush(batch.id),
        recovered ? 0 : maxWaitMs,
      );
      batch.maxTimer.unref();
    }
  };

  const recovered = database
    .prepare(
      `SELECT source_message_id, batch_id, user_id, received_at, chat_type,
              message_type, sender_type, raw_text, raw_payload_json
       FROM message_inbox
       WHERE status = 'pending'
       ORDER BY received_at ASC`,
    )
    .all() as unknown as InboxRow[];
  for (const row of recovered) {
    const batch = batches.get(row.batch_id) ?? {
      id: row.batch_id,
      userId: row.user_id,
      messages: [],
      settleTimer: undefined,
      maxTimer: undefined,
    };
    batch.messages.push(toMessage(row));
    batches.set(batch.id, batch);
    activeBatchByUser.set(batch.userId, batch.id);
  }
  for (const batch of batches.values()) {
    schedule(batch, true);
  }

  return {
    async accept(message) {
      if (stopped) {
        throw new Error("Message batcher is stopped");
      }
      if (!allowedUserIds.has(message.event.userId)) {
        await options.replies.reply({
          messageId: message.event.sourceMessageId,
          text: "这个 Bot 仅供已授权用户使用。",
          idempotencyKey: replyKey(message.event.sourceMessageId),
        });
        return;
      }
      const existingBatchId = activeBatchByUser.get(message.event.userId);
      const batchId = existingBatchId ?? message.event.sourceMessageId;
      const inserted = database
        .prepare(
          `INSERT OR IGNORE INTO message_inbox (
            source_message_id, batch_id, user_id, received_at, chat_type,
            message_type, sender_type, raw_text, raw_payload_json,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          message.event.sourceMessageId,
          batchId,
          message.event.userId,
          message.event.receivedAt,
          message.chatType,
          message.messageType,
          message.senderType,
          message.event.rawText,
          JSON.stringify(message.event.rawPayload),
          new Date().toISOString(),
          new Date().toISOString(),
        );
      if (inserted.changes === 0) {
        return;
      }
      const batch = batches.get(batchId) ?? {
        id: batchId,
        userId: message.event.userId,
        messages: [],
        settleTimer: undefined,
        maxTimer: undefined,
      };
      batch.messages.push(message);
      batches.set(batchId, batch);
      activeBatchByUser.set(batch.userId, batchId);
      schedule(batch);
      if (stripImmediateDirective(message.event.rawText).immediate) {
        await enqueueFlush(batchId);
      }
    },

    async flush() {
      await Promise.all([...batches.keys()].map(enqueueFlush));
      await processing;
    },

    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await Promise.all([...batches.keys()].map(enqueueFlush));
      await processing;
      for (const batch of batches.values()) {
        clearTimers(batch);
      }
      batches.clear();
      database.close();
    },
  };
}

export function createBatchedChannelHandler(
  batcher: MessageBatcher,
): Parameters<LarkEventChannel["start"]>[0] {
  return async (message) => {
    if (message.chatType !== "p2p" || message.senderType !== "user") {
      return;
    }
    await batcher.accept(message);
  };
}
