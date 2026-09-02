import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createDevelopmentAgent } from "../src/development-agent.js";
import type { MemoryRetainRequest } from "../src/memory.js";
import { createMemoryRetainWorker } from "../src/memory-retain-worker.js";

test("a high-value memory is queued without delaying the completed Event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-memory-worker-"));
  const databasePath = join(directory, "events.sqlite");
  const agent = createDevelopmentAgent({
    databasePath,
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [],
        acknowledgement: "知道了，之后我会先给结论。",
        memoryCandidates: [
          {
            key: "reply-style",
            category: "preference",
            content: "用户偏好回复先给结论。",
          },
        ],
      }),
    },
    stateAdapter: { project: async () => undefined },
    memoryRetentionEnabled: true,
  });
  const retained: MemoryRetainRequest[] = [];
  const worker = createMemoryRetainWorker({
    databasePath,
    memory: {
      recall: async () => [],
      retain: async (request) => {
        retained.push(request);
      },
    },
    retryDelayMs: 0,
  });

  try {
    const result = await agent.ingest({
      sourceMessageId: "om_memory_preference",
      receivedAt: "2026-09-02T19:00:00.000Z",
      userId: "user-1",
      rawText: "以后先给我结论",
      rawPayload: {},
    });
    assert.equal(result.status, "completed");
    assert.equal(retained.length, 0);
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(retained.length, 1);
    assert.deepEqual(retained[0]?.candidate, {
      key: "reply-style",
      category: "preference",
      content: "用户偏好回复先给结论。",
    });
    assert.match(
      retained[0]?.operationId ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  } finally {
    worker.close();
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retain failures retry a bounded five times with one operation ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-memory-retry-"));
  const databasePath = join(directory, "events.sqlite");
  const agent = createDevelopmentAgent({
    databasePath,
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [],
        acknowledgement: "已记下。",
        memoryCandidates: [
          {
            key: "stable-boundary",
            category: "boundary",
            content: "用户不希望自动向同事发送消息。",
          },
        ],
      }),
    },
    stateAdapter: { project: async () => undefined },
    memoryRetentionEnabled: true,
  });
  await agent.ingest({
    sourceMessageId: "om_memory_retry",
    receivedAt: "2026-09-02T19:05:00.000Z",
    userId: "user-1",
    rawText: "不要自动联系别人",
    rawPayload: {},
  });
  const operationIds: string[] = [];
  const worker = createMemoryRetainWorker({
    databasePath,
    memory: {
      recall: async () => [],
      retain: async (request) => {
        operationIds.push(request.operationId);
        throw new Error("Hindsight unavailable");
      },
    },
    retryDelayMs: 0,
  });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(await worker.runOnce(), true);
    }
    assert.equal(await worker.runOnce(), false);
    assert.equal(operationIds.length, 5);
    assert.equal(new Set(operationIds).size, 1);
    assert.equal(agent.getEvent("om_memory_retry")?.processingStatus, "completed");
  } finally {
    worker.close();
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a retain interrupted while running is recovered after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-memory-recovery-"));
  const databasePath = join(directory, "events.sqlite");
  const agent = createDevelopmentAgent({
    databasePath,
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [],
        acknowledgement: "已记下。",
        memoryCandidates: [
          {
            key: "contact-boundary",
            category: "boundary",
            content: "用户要求发送外部消息前先确认。",
          },
        ],
      }),
    },
    stateAdapter: { project: async () => undefined },
    memoryRetentionEnabled: true,
  });
  await agent.ingest({
    sourceMessageId: "om_memory_recovery",
    receivedAt: "2026-09-02T19:10:00.000Z",
    userId: "user-1",
    rawText: "发消息前先问我",
    rawPayload: {},
  });
  const database = new DatabaseSync(databasePath);
  database
    .prepare(
      `UPDATE outbox SET status = 'running'
       WHERE operation_type = 'memory.retain'`,
    )
    .run();
  database.close();
  let retainCount = 0;
  const worker = createMemoryRetainWorker({
    databasePath,
    memory: {
      recall: async () => [],
      retain: async () => {
        retainCount += 1;
      },
    },
  });

  try {
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(retainCount, 1);
  } finally {
    worker.close();
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
