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
      bitableBaseToken: "bas_state",
      bitableTables: {
        projects: "tbl_projects",
        items: "tbl_items",
        actionLinks: "tbl_actions",
      },
      memory: {
        enabled: false,
        baseUrl: "http://127.0.0.1:8888",
        bankId: "cas-personal-agent",
        recallTimeoutMs: 2_000,
        recallMaxResults: 5,
        recallMaxTokens: 800,
      },
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
              kind: "upsert_item",
              itemKey: "live-service-item",
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
      stateProjector: {
        project: async () => undefined,
      },
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
    assert.deepEqual(replies, [
      `Pi 回复：${JSON.stringify({
        trustedContext: {
          receivedAt: "2026-09-02T18:20:00.000Z",
          receivedLocalDateTime: "2026-09-03 02:20:00",
          userTimeZone: "Asia/Shanghai",
        },
        userMessage: "继续真实闭环",
      })}`,
    ]);
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

test("memory-enabled live service recalls before Pi and retains after reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-live-memory-"));
  const databasePath = join(directory, "events.sqlite");
  let handler:
    | ((message: IncomingChannelMessage) => Promise<void>)
    | undefined;
  const replies: string[] = [];
  const retained: string[] = [];
  const service = await createLiveService(
    {
      cwd: directory,
      databasePath,
      allowedUserIds: ["ou_authorized"],
      piSessionDirectory: join(directory, "pi-sessions"),
      piModel: "openai-codex/gpt-5.6-luna",
      bitableBaseToken: "bas_state",
      bitableTables: {
        projects: "tbl_projects",
        items: "tbl_items",
        actionLinks: "tbl_actions",
      },
      memory: {
        enabled: true,
        baseUrl: "http://127.0.0.1:8888",
        bankId: "cas-personal-agent",
        recallTimeoutMs: 50,
        recallMaxResults: 5,
        recallMaxTokens: 800,
      },
    },
    {
      channel: {
        start: async (onMessage) => {
          handler = onMessage;
        },
        stop: async () => undefined,
        waitForExit: () => new Promise<void>(() => undefined),
        status: () => (handler === undefined ? "stopped" : "running"),
      },
      replies: {
        reply: async ({ text }) => {
          replies.push(text);
        },
      },
      runtimeFactory: async ({ memoryEnabled }) => {
        assert.equal(memoryEnabled, true);
        return {
          sessionId: "pi-live-memory",
          sessionPath: join(directory, "pi-live-memory.jsonl"),
          runTurn: async (prompt) => ({
            changes: [],
            acknowledgement: prompt,
            memoryCandidates: [
              {
                key: "reply-style",
                category: "preference",
                content: "用户偏好先给结论。",
              },
            ],
          }),
          dispose: () => undefined,
        };
      },
      stateProjector: { project: async () => undefined },
      memoryAdapter: {
        recall: async () => [
          {
            id: "memory-old",
            text: "用户偏好先给结论。",
            type: "world",
            source: {
              system: "hindsight",
              documentId: "cas:old:reply-style",
              sourceEventId: "om_old",
              mentionedAt: "2026-09-01T10:00:00Z",
            },
          },
        ],
        retain: async ({ candidate }) => {
          retained.push(candidate.content);
        },
      },
    },
  );

  try {
    await service.start();
    assert.ok(handler);
    await handler({
      event: {
        sourceMessageId: "om_live_memory",
        receivedAt: "2026-09-02T19:20:00.000Z",
        userId: "ou_authorized",
        rawText: "以后都按我的习惯回复",
        rawPayload: {},
      },
      chatType: "p2p",
      messageType: "text",
      senderType: "user",
    });
    assert.equal(replies.length, 1);
    assert.match(replies[0] ?? "", /recalledMemories/);
    assert.equal(retained.length, 0);
  } finally {
    await service.stop();
  }

  assert.deepEqual(retained, ["用户偏好先给结论。"]);
  await rm(directory, { recursive: true, force: true });
});
