import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentAgent } from "../src/development-agent.js";
import type {
  IncomingChannelMessage,
  LarkEventChannel,
} from "../src/lark-event-channel.js";
import type { ReplyRequest } from "../src/lark-reply-adapter.js";
import { createSupervisor } from "../src/supervisor.js";

test("the Supervisor carries one private Lark message through durable ingestion to a bot reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-supervisor-"));
  let handler:
    | ((message: IncomingChannelMessage) => Promise<void>)
    | undefined;
  const channel: LarkEventChannel = {
    start: async (onMessage) => {
      handler = onMessage;
    },
    stop: async () => undefined,
    waitForExit: () => new Promise<void>(() => undefined),
    status: () => (handler === undefined ? "stopped" : "running"),
  };
  const replies: ReplyRequest[] = [];
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["ou_authorized"],
    interpreter: {
      interpret: async () => ({
        changes: [
          {
            kind: "item",
            title: "继续报价项目",
            type: "task",
            status: "actionable",
          },
        ],
        acknowledgement: "报价项目可以继续：先检查客户反馈。",
      }),
    },
    stateAdapter: {
      project: async () => undefined,
    },
  });
  const supervisor = createSupervisor({
    channel,
    agent,
    replies: {
      reply: async (request) => {
        replies.push(request);
      },
    },
  });

  try {
    await supervisor.start();
    assert.ok(handler);
    await handler({
      event: {
        sourceMessageId: "om_supervisor_1",
        receivedAt: "2026-09-02T17:45:00.000Z",
        userId: "ou_authorized",
        rawText: "继续报价项目",
        rawPayload: { event_id: "delivery-supervisor-1" },
      },
      chatType: "p2p",
      messageType: "text",
      senderType: "user",
    });

    assert.equal(
      agent.getEvent("om_supervisor_1")?.processingStatus,
      "completed",
    );
    assert.deepEqual(replies, [
      {
        messageId: "om_supervisor_1",
        text: "报价项目可以继续：先检查客户反馈。",
        idempotencyKey: "reply-om_supervisor_1",
      },
    ]);

    await handler({
      event: {
        sourceMessageId: "om_group_ignored",
        receivedAt: "2026-09-02T17:46:00.000Z",
        userId: "ou_authorized",
        rawText: "群聊内容",
        rawPayload: { event_id: "delivery-group" },
      },
      chatType: "group",
      messageType: "text",
      senderType: "user",
    });
    assert.equal(replies.length, 1);
    assert.equal(agent.getEvent("om_group_ignored"), undefined);
  } finally {
    await supervisor.stop();
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
