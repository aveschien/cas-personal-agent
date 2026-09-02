import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiInterpreter } from "../src/pi-interpreter.js";
import { createPiSessionRegistry } from "../src/pi-session-registry.js";

test("the Pi Interpreter preserves multi-turn state and records each completed turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-pi-"));
  const registry = createPiSessionRegistry(join(directory, "events.sqlite"));
  const prompts: string[] = [];
  let disposed = false;
  const times = [
    "2026-09-02T18:10:00.000Z",
    "2026-09-02T18:11:00.000Z",
    "2026-09-02T18:12:00.000Z",
  ];
  const interpreter = createPiInterpreter({
    logicalConversationId: "cas-main",
    registry,
    clock: () => times.shift() ?? "2026-09-02T18:13:00.000Z",
    runtime: {
      sessionId: "pi-session-multiturn",
      sessionPath: join(directory, "pi-session-multiturn.jsonl"),
      runTurn: async (prompt) => {
        prompts.push(prompt);
        return {
          changes: [
            {
              kind: "item",
              title: prompt,
              type: "information",
              status: "inbox",
            },
          ],
          acknowledgement: `已理解：${prompt}`,
        };
      },
      dispose: () => {
        disposed = true;
      },
    },
  });

  try {
    await interpreter.interpret({
      sourceMessageId: "om_turn_1",
      receivedAt: "2026-09-02T18:10:00.000Z",
      userId: "ou_authorized",
      rawText: "记住报价项目",
      rawPayload: {},
    });
    const second = await interpreter.interpret({
      sourceMessageId: "om_turn_2",
      receivedAt: "2026-09-02T18:11:00.000Z",
      userId: "ou_authorized",
      rawText: "刚才说的项目是什么",
      rawPayload: {},
    });

    assert.deepEqual(prompts, [
      JSON.stringify({
        trustedContext: {
          receivedAt: "2026-09-02T18:10:00.000Z",
          receivedLocalDateTime: "2026-09-02 11:10:00",
          userTimeZone: "America/Los_Angeles",
        },
        userMessage: "记住报价项目",
      }),
      JSON.stringify({
        trustedContext: {
          receivedAt: "2026-09-02T18:11:00.000Z",
          receivedLocalDateTime: "2026-09-02 11:11:00",
          userTimeZone: "America/Los_Angeles",
        },
        userMessage: "刚才说的项目是什么",
      }),
    ]);
    assert.equal(second.acknowledgement, `已理解：${prompts[1]}`);
    assert.equal(registry.getActive("cas-main")?.turnCount, 2);
  } finally {
    interpreter.dispose();
    assert.equal(disposed, true);
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
