import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  createPiSdkRuntime,
  type PiSdkSession,
  type PiSdkSessionFactoryInput,
} from "../src/pi-sdk-runtime.js";

test("the Pi SDK runtime exposes only the controlled state proposal tool", async () => {
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
            input.proposeItem({
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

  assert.deepEqual(factoryInput?.enabledToolNames, ["state_propose_item"]);
  assert.equal(factoryInput?.disableBuiltinTools, true);
  assert.match(factoryInput?.systemPrompt ?? "", /不得使用 shell/);
  assert.deepEqual(prompts, ["修改报价页", "继续刚才的事项"]);
  assert.deepEqual(first, {
    changes: [
      {
        kind: "item",
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
