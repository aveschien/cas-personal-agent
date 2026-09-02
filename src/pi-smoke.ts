import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createPiSdkRuntime } from "./pi-sdk-runtime.js";

export async function runPiSmoke(
  cwd = process.cwd(),
  modelName = process.env.CAS_PI_MODEL ?? "openai-codex/gpt-5.6-luna",
): Promise<void> {
  const runtime = await createPiSdkRuntime({
    cwd,
    sessionDirectory: join(cwd, "var", "pi-smoke"),
    modelName,
  });
  const title = "完成真实 Pi smoke 测试";
  try {
    const first = await runtime.runTurn(
      `请调用 state_apply_operation，用 key=pi-smoke-item 把“${title}”分类为 task/actionable，然后简短确认。`,
    );
    assert.deepEqual(first.changes, [
      {
        kind: "upsert_item",
        itemKey: "pi-smoke-item",
        title,
        type: "task",
        status: "actionable",
      },
    ]);

    const second = await runtime.runTurn(
      "上一轮让我记录的事项标题是什么？请只回复标题。",
    );
    assert.match(second.acknowledgement, new RegExp(title));

    console.log(
      JSON.stringify({
        status: "ok",
        model: modelName,
        sessionId: runtime.sessionId,
        controlledToolChanges: first.changes.length,
        multiTurnContext: true,
      }),
    );
  } finally {
    runtime.dispose();
  }
}

const executable = process.argv[1];
if (
  executable !== undefined &&
  pathToFileURL(executable).href === import.meta.url
) {
  runPiSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
