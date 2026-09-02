import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentAgent } from "../src/development-agent.js";

test("re-delivery of one Feishu message does not repeat interpretation or projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-"));
  let interpretationCount = 0;
  let projectionCount = 0;
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => {
        interpretationCount += 1;
        return {
          changes: [{ kind: "idea", title: "换一种数据治理讲法" }],
          acknowledgement: "已暂存这个想法。",
        };
      },
    },
    stateAdapter: {
      project: async () => {
        projectionCount += 1;
      },
    },
  });
  const event = {
    sourceMessageId: "message-repeated",
    receivedAt: "2026-09-02T17:10:00.000Z",
    userId: "user-1",
    rawText: "数据治理那里也许可以换个讲法，不过先别管",
    rawPayload: { event_id: "delivery-first" },
  } as const;

  try {
    const first = await agent.ingest(event);
    const repeated = await agent.ingest({
      ...event,
      rawPayload: { event_id: "delivery-repeated" },
    });

    assert.deepEqual(first, {
      status: "completed",
      acknowledgement: "已暂存这个想法。",
    });
    assert.deepEqual(repeated, {
      status: "duplicate",
      acknowledgement: "已暂存这个想法。",
    });
    assert.equal(interpretationCount, 1);
    assert.equal(projectionCount, 1);
  } finally {
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
