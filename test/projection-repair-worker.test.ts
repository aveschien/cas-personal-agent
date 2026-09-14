import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentAgent } from "../src/development-agent.js";
import { createProjectionRepairWorker } from "../src/projection-repair-worker.js";

test("a queued Bitable repair completes the degraded Event exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-repair-worker-"));
  const databasePath = join(directory, "events.sqlite");
  const operation = {
    kind: "park_idea" as const,
    itemKey: "repair-idea",
    title: "修复投影",
  };
  const agent = createDevelopmentAgent({
    databasePath,
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [operation],
        acknowledgement: "已暂存想法。",
      }),
    },
    stateAdapter: {
      project: async () => {
        throw new Error("temporary Bitable failure");
      },
    },
  });
  await assert.rejects(
    agent.ingest({
      sourceMessageId: "om_repair_worker",
      receivedAt: "2026-09-02T18:00:00.000Z",
      userId: "user-1",
      rawText: "先放着",
      rawPayload: {},
    }),
  );
  const projections: unknown[] = [];
  const worker = createProjectionRepairWorker({
    databasePath,
    projector: {
      project: async (input) => {
        projections.push(input);
      },
    },
    retryDelayMs: 0,
  });

  try {
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.deepEqual(projections, [
      {
        sourceEventId: "om_repair_worker",
        occurredAt: "2026-09-02T18:00:00.000Z",
        operations: [operation],
      },
    ]);
    assert.deepEqual(agent.getEvent("om_repair_worker"), {
      source: "feishu",
      sourceMessageId: "om_repair_worker",
      userId: "user-1",
      rawText: "先放着",
      processingStatus: "completed",
      acknowledgement: "已暂存想法。",
    });
    assert.equal(agent.getRepair("om_repair_worker")?.status, "succeeded");
    assert.equal(agent.getRepair("om_repair_worker")?.attemptCount, 2);
  } finally {
    worker.close();
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a repair becomes dead after the bounded fifth total attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-repair-dead-"));
  const databasePath = join(directory, "events.sqlite");
  const agent = createDevelopmentAgent({
    databasePath,
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [
          {
            kind: "park_idea" as const,
            itemKey: "dead-repair",
            title: "持续失败",
          },
        ],
        acknowledgement: "已暂存。",
      }),
    },
    stateAdapter: {
      project: async () => {
        throw new Error("initial failure");
      },
    },
  });
  await assert.rejects(
    agent.ingest({
      sourceMessageId: "om_dead_repair",
      receivedAt: "2026-09-02T18:00:00.000Z",
      userId: "user-1",
      rawText: "一直失败",
      rawPayload: {},
    }),
  );
  const worker = createProjectionRepairWorker({
    databasePath,
    projector: {
      project: async () => {
        throw new Error("still unavailable");
      },
    },
    retryDelayMs: 0,
  });

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(await worker.runOnce(), true);
    }
    assert.equal(await worker.runOnce(), false);
    assert.equal(agent.getRepair("om_dead_repair")?.status, "dead");
    assert.equal(agent.getRepair("om_dead_repair")?.attemptCount, 5);
    assert.equal(agent.getEvent("om_dead_repair")?.processingStatus, "degraded");
  } finally {
    worker.close();
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
