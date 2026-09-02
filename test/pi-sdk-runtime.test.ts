import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  createPiSdkRuntime,
  type PiSdkSession,
  type PiSdkSessionFactoryInput,
} from "../src/pi-sdk-runtime.js";

test("the Pi SDK runtime exposes only the controlled semantic operation tool", async () => {
  let factoryInput: PiSdkSessionFactoryInput | undefined;
  let listener: ((delta: string) => void) | undefined;
  let disposed = false;
  const prompts: string[] = [];
  const runtime = await createPiSdkRuntime({
    cwd: "/srv/cas-agent",
    sessionDirectory: "/srv/cas-agent/var/pi-sessions",
    modelName: "openai-codex/gpt-5.6-luna",
    sdkFactory: {
      create: async (input) => {
        factoryInput = input;
        const session: PiSdkSession = {
          sessionId: "pi-sdk-session-1",
          sessionPath: join(input.sessionDirectory, "pi-sdk-session-1.jsonl"),
          subscribeText: (onText) => {
            listener = onText;
            return () => {
              listener = undefined;
            };
          },
          prompt: async (prompt) => {
            prompts.push(prompt);
            input.proposeOperation({
              kind: "upsert_item",
              itemKey: `item-${prompts.length}`,
              title: prompt,
              type: "task",
              status: "actionable",
            });
            listener?.(`已整理：${prompt}`);
          },
          dispose: () => {
            disposed = true;
          },
        };
        return session;
      },
    },
  });

  const first = await runtime.runTurn("修改报价页");
  const second = await runtime.runTurn("继续刚才的事项");

  assert.deepEqual(factoryInput?.enabledToolNames, ["state_apply_operation"]);
  assert.equal(factoryInput?.disableBuiltinTools, true);
  assert.match(factoryInput?.systemPrompt ?? "", /不得使用 shell/);
  assert.deepEqual(prompts, ["修改报价页", "继续刚才的事项"]);
  assert.deepEqual(first, {
    changes: [
      {
        kind: "upsert_item",
        itemKey: "item-1",
        title: "修改报价页",
        type: "task",
        status: "actionable",
      },
    ],
    acknowledgement: "已整理：修改报价页",
  });
  assert.equal(second.acknowledgement, "已整理：继续刚才的事项");

  runtime.dispose();
  assert.equal(disposed, true);
});

test("memory-enabled Pi can propose a selected durable memory", async () => {
  let factoryInput: PiSdkSessionFactoryInput | undefined;
  const runtime = await createPiSdkRuntime({
    cwd: "/srv/cas-agent",
    sessionDirectory: "/srv/cas-agent/var/pi-sessions",
    modelName: "openai-codex/gpt-5.6-luna",
    memoryEnabled: true,
    sdkFactory: {
      create: async (input) => {
        factoryInput = input;
        return {
          sessionId: "pi-memory-tool",
          sessionPath: join(input.sessionDirectory, "pi-memory-tool.jsonl"),
          subscribeText: () => () => undefined,
          prompt: async () => {
            input.proposeMemoryCandidate({
              key: "reply-style",
              category: "preference",
              content: "用户偏好先给结论。",
            });
          },
          dispose: () => undefined,
        };
      },
    },
  });

  try {
    assert.deepEqual(await runtime.runTurn("以后先说结论"), {
      changes: [],
      acknowledgement: "已收到，我会继续处理这条信息。",
      memoryCandidates: [
        {
          key: "reply-style",
          category: "preference",
          content: "用户偏好先给结论。",
        },
      ],
    });
    assert.deepEqual(factoryInput?.enabledToolNames, [
      "state_apply_operation",
      "memory_propose_retain",
    ]);
  } finally {
    runtime.dispose();
  }
});
