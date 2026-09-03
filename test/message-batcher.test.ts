import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChannelEvent } from "../src/development-agent.js";
import type { IncomingChannelMessage } from "../src/lark-event-channel.js";
import { createMessageBatcher } from "../src/message-batcher.js";
import type { PromptImage } from "../src/prompt-image.js";
import { initializeStorage } from "../src/storage.js";

function message(
  id: string,
  text: string,
  messageType = "text",
): IncomingChannelMessage {
  return {
    event: {
      sourceMessageId: id,
      receivedAt: `2026-09-02T12:00:0${id.at(-1) ?? "0"}.000Z`,
      userId: "ou_owner",
      rawText: text,
      rawPayload: { message_id: id, content: text },
    },
    chatType: "p2p",
    messageType,
    senderType: "user",
  };
}

test("consecutive text and image messages become one Pi turn and one reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-message-batch-"));
  const databasePath = join(directory, "events.sqlite");
  const ingested: ChannelEvent[] = [];
  const replied: { messageId: string; text: string }[] = [];
  const loaded: IncomingChannelMessage[][] = [];
  const image: PromptImage = {
    type: "image",
    data: "iVBORw0KGgo=",
    mimeType: "image/png",
  };
  const batcher = createMessageBatcher({
    databasePath,
    allowedUserIds: ["ou_owner"],
    settleMs: 60_000,
    maxWaitMs: 60_000,
    agent: {
      ingest: async (event) => {
        ingested.push(event);
        return { status: "completed", acknowledgement: "整批处理完成" };
      },
    },
    replies: {
      reply: async (request) => {
        replied.push({ messageId: request.messageId, text: request.text });
      },
    },
    images: {
      load: async (messages) => {
        loaded.push([...messages]);
        return [image];
      },
    },
  });
  try {
    await batcher.accept(message("om_1", "先帮我整理这件事"));
    await batcher.accept(
      message("om_2", JSON.stringify({ image_key: "img_1" }), "image"),
    );
    assert.equal(ingested.length, 0);

    await batcher.flush();

    assert.equal(ingested.length, 1);
    assert.match(ingested[0]?.rawText ?? "", /先帮我整理这件事/);
    assert.match(ingested[0]?.rawText ?? "", /图片已附加/);
    assert.deepEqual(ingested[0]?.images, [image]);
    assert.deepEqual(
      loaded[0]?.map((entry) => entry.event.sourceMessageId),
      ["om_1", "om_2"],
    );
    assert.deepEqual(replied, [
      { messageId: "om_2", text: "整批处理完成" },
    ]);
    const database = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(
        database
          .prepare(
            "SELECT source_message_id, status FROM message_inbox ORDER BY received_at",
          )
          .all()
          .map((row) => ({ ...row })),
        [
          { source_message_id: "om_1", status: "completed" },
          { source_message_id: "om_2", status: "completed" },
        ],
      );
    } finally {
      database.close();
    }
  } finally {
    await batcher.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an immediate directive flushes the current batch without becoming content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-message-now-"));
  const databasePath = join(directory, "events.sqlite");
  const prompts: string[] = [];
  const replyIds: string[] = [];
  const batcher = createMessageBatcher({
    databasePath,
    allowedUserIds: ["ou_owner"],
    settleMs: 60_000,
    maxWaitMs: 60_000,
    agent: {
      ingest: async (event) => {
        prompts.push(event.rawText);
        return { status: "completed", acknowledgement: "现在答" };
      },
    },
    replies: {
      reply: async (request) => {
        replyIds.push(request.messageId);
      },
    },
    images: { load: async () => [] },
  });
  try {
    await batcher.accept(message("om_1", "第一部分"));
    await batcher.accept(message("om_2", "立即回答：第二部分"));

    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /第一部分/);
    assert.match(prompts[0] ?? "", /第二部分/);
    assert.doesNotMatch(prompts[0] ?? "", /立即回答/);
    assert.deepEqual(replyIds, ["om_2"]);
  } finally {
    await batcher.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending inbox messages recover as one batch after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-message-recovery-"));
  const databasePath = join(directory, "events.sqlite");
  const database = new DatabaseSync(databasePath);
  initializeStorage(database);
  const payload = JSON.stringify({ message_id: "om_recovered" });
  database
    .prepare(
      `INSERT INTO message_inbox (
        source_message_id, batch_id, user_id, received_at, chat_type,
        message_type, sender_type, raw_text, raw_payload_json, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'p2p', 'text', 'user', ?, ?, 'processing', ?, ?)`,
    )
    .run(
      "om_recovered",
      "om_recovered",
      "ou_owner",
      "2026-09-02T12:00:00.000Z",
      "重启前收到的内容",
      payload,
      "2026-09-02T12:00:00.000Z",
      "2026-09-02T12:00:00.000Z",
    );
  database.close();
  const prompts: string[] = [];
  const batcher = createMessageBatcher({
    databasePath,
    allowedUserIds: ["ou_owner"],
    agent: {
      ingest: async (event) => {
        prompts.push(event.rawText);
        return { status: "completed", acknowledgement: "恢复完成" };
      },
    },
    replies: { reply: async () => undefined },
    images: { load: async () => [] },
  });
  try {
    await batcher.flush();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /重启前收到的内容/);
  } finally {
    await batcher.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
