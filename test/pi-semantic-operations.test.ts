import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  createPiSdkRuntime,
  type PiSdkSession,
  type PiSdkSessionFactoryInput,
} from "../src/pi-sdk-runtime.js";

test("Pi can emit multiple controlled semantic operations for one mixed input", async () => {
  let factoryInput: PiSdkSessionFactoryInput | undefined;
  let listener: ((delta: string) => void) | undefined;
  const runtime = await createPiSdkRuntime({
    cwd: "/srv/cas-agent",
    sessionDirectory: "/srv/cas-agent/var/pi-sessions",
    modelName: "openai-codex/gpt-5.6-luna",
    sdkFactory: {
      create: async (input) => {
        factoryInput = input;
        const session: PiSdkSession = {
          sessionId: "pi-semantic-session",
          sessionPath: join(input.sessionDirectory, "pi-semantic.jsonl"),
          subscribeText: (onText) => {
            listener = onText;
            return () => {
              listener = undefined;
            };
          },
          prompt: async () => {
            input.proposeOperation({
              kind: "upsert_item",
              itemKey: "proposal-feedback",
              title: "方案反馈",
              type: "task",
              status: "waiting",
            });
            input.proposeOperation({
              kind: "set_waiting",
              itemKey: "proposal-feedback",
              waitingFor: "张总反馈",
              releaseCondition: "收到反馈",
              checkpointAt: "2026-09-04T09:00:00+08:00",
              contingency: "若仍无反馈则联系张总",
            });
            input.proposeOperation({
              kind: "park_idea",
              itemKey: "new-wording",
              title: "换一种讲法",
            });
            listener?.("已拆分等待事项和暂存想法；周五检查。");
          },
          dispose: () => undefined,
        };
        return session;
      },
    },
  });

  const result = await runtime.runTurn("一个混合输入");
  assert.deepEqual(factoryInput?.enabledToolNames, ["state_apply_operation", "state_query_local", "state_refresh_object"]);
  assert.match(factoryInput?.systemPrompt ?? "", /最小澄清/);
  assert.equal(result.changes.length, 3);
  assert.equal(result.changes[1]?.kind, "set_waiting");
  assert.equal(result.changes[2]?.kind, "park_idea");
  assert.equal(result.acknowledgement, "已拆分等待事项和暂存想法；周五检查。");
  runtime.dispose();
});

test("collaborative Actions expose only read-only contact resolution beside semantic tools", async () => {
  let factoryInput: PiSdkSessionFactoryInput | undefined;
  const runtime = await createPiSdkRuntime({
    cwd: "/srv/cas-agent",
    sessionDirectory: "/srv/cas-agent/var/pi-sessions",
    modelName: "openai-codex/gpt-5.6-luna",
    collaborativeActionsEnabled: true,
    collaboratorResolver: {
      resolve: async () => [
        {
          openId: "ou_xiaowang",
          name: "小王",
          isCrossTenant: false,
        },
      ],
    },
    sdkFactory: {
      create: async (input) => {
        factoryInput = input;
        return {
          sessionId: "pi-collaborative-session",
          sessionPath: join(input.sessionDirectory, "pi-collaborative.jsonl"),
          subscribeText: () => () => undefined,
          prompt: async () => undefined,
          dispose: () => undefined,
        };
      },
    },
  });
  assert.deepEqual(factoryInput?.enabledToolNames, [
    "state_apply_operation",
    "state_query_local",
    "state_refresh_object",
    "contact_resolve_collaborator",
  ]);
  assert.match(factoryInput?.systemPrompt ?? "", /无需二次确认/);
  assert.match(factoryInput?.systemPrompt ?? "", /零结果或多结果时只生成 clarify/);
  runtime.dispose();
});

test("collaborative Actions cannot start without a controlled resolver", async () => {
  await assert.rejects(
    createPiSdkRuntime({
      cwd: "/srv/cas-agent",
      sessionDirectory: "/srv/cas-agent/var/pi-sessions",
      modelName: "openai-codex/gpt-5.6-luna",
      collaborativeActionsEnabled: true,
      sdkFactory: {
        create: async () => {
          throw new Error("must not create a session");
        },
      },
    }),
    /require a Feishu collaborator resolver/,
  );
});
