import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  IncomingChannelMessage,
  LarkEventChannel,
} from "../src/lark-event-channel.js";
import { createLiveService } from "../src/live-service.js";
import { createPiSessionRegistry } from "../src/pi-session-registry.js";

test("the live service wires a persistent Pi runtime to the Lark Supervisor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-live-"));
  const databasePath = join(directory, "events.sqlite");
  let handler:
    | ((message: IncomingChannelMessage) => Promise<void>)
    | undefined;
  let runtimeDisposed = false;
  const replies: string[] = [];
  const channel: LarkEventChannel = {
    start: async (onMessage) => {
      handler = onMessage;
    },
    stop: async () => undefined,
    waitForExit: () => new Promise<void>(() => undefined),
    status: () => (handler === undefined ? "stopped" : "running"),
  };
  const service = await createLiveService(
    {
      cwd: directory,
      databasePath,
      allowedUserIds: ["ou_authorized"],
      piSessionDirectory: join(directory, "pi-sessions"),
      piModel: "openai-codex/gpt-5.6-luna",
    },
    {
      channel,
      replies: {
        reply: async (request) => {
          replies.push(request.text);
        },
      },
      runtimeFactory: async () => ({
        sessionId: "pi-live-session-1",
        sessionPath: join(directory, "pi-live-session-1.jsonl"),
        runTurn: async (prompt) => ({
          changes: [
            {
              kind: "item",
              title: prompt,
              type: "task",
              status: "actionable",
            },
          ],
          acknowledgement: `Pi 回复：${prompt}`,
        }),
        dispose: () => {
          runtimeDisposed = true;
        },
      }),
    },
  );

  try {
    await service.start();
    assert.ok(handler);
    await handler({
      event: {
        sourceMessageId: "om_live_service_1",
        receivedAt: "2026-09-02T18:20:00.000Z",
        userId: "ou_authorized",
        rawText: "继续真实闭环",
        rawPayload: { event_id: "delivery-live-service" },
      },
      chatType: "p2p",
      messageType: "text",
      senderType: "user",
    });
    assert.deepEqual(replies, ["Pi 回复：继续真实闭环"]);
  } finally {
    await service.stop();
  }

  assert.equal(runtimeDisposed, true);
  const registry = createPiSessionRegistry(databasePath);
  try {
    const active = registry.getActive("cas-main");
    assert.equal(active?.logicalConversationId, "cas-main");
    assert.equal(active?.piSessionId, "pi-live-session-1");
    assert.equal(
      active?.piSessionPath,
      join(directory, "pi-live-session-1.jsonl"),
    );
    assert.equal(active?.status, "active");
    assert.equal(active?.turnCount, 1);
    assert.match(active?.lastActivityAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
