import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createLarkEventChannel } from "../src/lark-event-channel.js";

test("the Lark Channel waits for ready, keeps stdin open, emits NDJSON, and stops gracefully", async () => {
  const received = Promise.withResolvers<unknown>();
  const channel = createLarkEventChannel({
    command: process.execPath,
    args: [join(process.cwd(), "dist/test/fixtures/fake-lark-event-consumer.js")],
  });

  await channel.start(async (message) => {
    received.resolve(message);
  });

  assert.deepEqual(await received.promise, {
    event: {
      sourceMessageId: "om_live_1",
      receivedAt: "2026-09-02T17:40:00.000Z",
      userId: "ou_authorized",
      rawText: "继续报价项目",
      rawPayload: {
        type: "im.message.receive_v1",
        event_id: "delivery-live-1",
        message_id: "om_live_1",
        chat_id: "oc_private_1",
        chat_type: "p2p",
        message_type: "text",
        sender_id: "ou_authorized",
        sender_type: "user",
        content: "继续报价项目",
        create_time: "1788370800000",
        timestamp: "1788370801000",
      },
    },
    chatType: "p2p",
    messageType: "text",
    senderType: "user",
  });

  await channel.stop();
  assert.equal(channel.status(), "stopped");
});
