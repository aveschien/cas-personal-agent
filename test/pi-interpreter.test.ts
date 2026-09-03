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
          receivedLocalDateTime: "2026-09-03 02:10:00",
          userTimeZone: "Asia/Shanghai",
        },
        userMessage: "记住报价项目",
      }),
      JSON.stringify({
        trustedContext: {
          receivedAt: "2026-09-02T18:11:00.000Z",
          receivedLocalDateTime: "2026-09-03 02:11:00",
          userTimeZone: "Asia/Shanghai",
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

test("memory recall is injected with provenance and failure degrades silently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-memory-recall-"));
  const registry = createPiSessionRegistry(join(directory, "events.sqlite"));
  const prompts: string[] = [];
  const errors: unknown[] = [];
  let recallCount = 0;
  const interpreter = createPiInterpreter({
    logicalConversationId: "cas-main",
    registry,
    runtime: {
      sessionId: "pi-memory-session",
      sessionPath: join(directory, "pi-memory-session.jsonl"),
      runTurn: async (prompt) => {
        prompts.push(prompt);
        return { changes: [], acknowledgement: "继续处理。" };
      },
      dispose: () => undefined,
    },
    memory: {
      recall: async () => {
        recallCount += 1;
        if (recallCount === 2) {
          throw new Error("Hindsight timeout");
        }
        return [
          {
            id: "memory-1",
            text: "用户偏好先给结论。",
            type: "world",
            source: {
              system: "hindsight",
              documentId: "cas:old:reply-style",
              sourceEventId: "om_old",
              mentionedAt: "2026-09-01T10:00:00Z",
            },
          },
        ];
      },
    },
    onMemoryError: (error) => errors.push(error),
  });

  try {
    await interpreter.interpret({
      sourceMessageId: "om_memory_1",
      receivedAt: "2026-09-02T19:10:00.000Z",
      userId: "ou_authorized",
      rawText: "按我的习惯回复",
      rawPayload: {},
    });
    const second = await interpreter.interpret({
      sourceMessageId: "om_memory_2",
      receivedAt: "2026-09-02T19:11:00.000Z",
      userId: "ou_authorized",
      rawText: "继续",
      rawPayload: {},
    });
    const firstPrompt = JSON.parse(prompts[0] ?? "{}") as {
      trustedContext?: { recalledMemories?: unknown[] };
    };
    const secondPrompt = JSON.parse(prompts[1] ?? "{}") as {
      trustedContext?: { recalledMemories?: unknown[] };
    };
    assert.equal(firstPrompt.trustedContext?.recalledMemories?.length, 1);
    assert.equal(secondPrompt.trustedContext?.recalledMemories, undefined);
    assert.equal(second.acknowledgement, "继续处理。");
    assert.equal(errors.length, 1);
  } finally {
    interpreter.dispose();
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative Action corrections reach Pi and become memory candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-authority-"));
  const registry = createPiSessionRegistry(join(directory, "events.sqlite"));
  let prompt = "";
  const interpreter = createPiInterpreter({
    logicalConversationId: "cas-main",
    registry,
    runtime: {
      sessionId: "pi-authority-session",
      sessionPath: join(directory, "pi-authority-session.jsonl"),
      runTurn: async (value) => {
        prompt = value;
        return { changes: [], acknowledgement: "已按滴答最新状态处理。" };
      },
      dispose: () => undefined,
    },
    authoritativeActions: {
      reconcile: async () => ({
        states: [
          {
            actionKey: "finish-proposal",
            title: "完成方案",
            factOwner: "ticktick",
            status: "completed",
            correctedFields: ["完成状态"],
          },
        ],
        memoryCandidates: [
          {
            key: "action-correction-finish-proposal-abc",
            category: "correction",
            content: "权威纠正：完成方案已在滴答完成。",
          },
        ],
      }),
    },
  });
  try {
    const result = await interpreter.interpret({
      sourceMessageId: "om_authority",
      receivedAt: "2026-09-03T03:00:00.000Z",
      userId: "ou_authorized",
      rawText: "这个方案现在怎么样",
      rawPayload: {},
    });
    const parsed = JSON.parse(prompt) as {
      trustedContext: { authoritativeActions?: unknown[] };
    };
    assert.equal(parsed.trustedContext.authoritativeActions?.length, 1);
    assert.match(prompt, /"status":"completed"/);
    assert.deepEqual(result.memoryCandidates, [
      {
        key: "action-correction-finish-proposal-abc",
        category: "correction",
        content: "权威纠正：完成方案已在滴答完成。",
      },
    ]);
  } finally {
    interpreter.dispose();
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative Bitable corrections reach Pi ahead of stale context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-bitable-authority-"));
  const registry = createPiSessionRegistry(join(directory, "events.sqlite"));
  let prompt = "";
  const interpreter = createPiInterpreter({
    logicalConversationId: "cas-main",
    registry,
    runtime: {
      sessionId: "pi-bitable-authority",
      sessionPath: join(directory, "pi-bitable-authority.jsonl"),
      runTurn: async (value) => {
        prompt = value;
        return { changes: [], acknowledgement: "已按表格最新状态处理。" };
      },
      dispose: () => undefined,
    },
    authoritativeBitable: {
      reconcile: async () => ({
        projects: [],
        items: [
          {
            recordId: "rec_item",
            itemKey: "proposal-feedback",
            title: "等待方案反馈",
            status: "完成",
            parked: false,
            correctedFields: ["状态"],
          },
        ],
        memoryCandidates: [
          {
            key: "bitable-correction-abc",
            category: "correction",
            content: "权威纠正：事项已在多维表格中设为完成。",
          },
        ],
      }),
    },
  });
  try {
    const result = await interpreter.interpret({
      sourceMessageId: "om_bitable_authority",
      receivedAt: "2026-09-03T03:00:00.000Z",
      userId: "ou_authorized",
      rawText: "继续处理这个事项",
      rawPayload: {},
    });
    assert.match(prompt, /"authoritativeItems"/);
    assert.match(prompt, /"correctedFields":\["状态"\]/);
    assert.deepEqual(result.memoryCandidates, [
      {
        key: "bitable-correction-abc",
        category: "correction",
        content: "权威纠正：事项已在多维表格中设为完成。",
      },
    ]);
  } finally {
    interpreter.dispose();
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
