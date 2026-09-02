import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createPiSdkRuntime } from "./pi-sdk-runtime.js";

export async function runMemoryCandidateSmoke(
  cwd = process.cwd(),
): Promise<void> {
  const sessionDirectory = await mkdtemp(
    join(tmpdir(), "cas-pi-memory-candidate-smoke-"),
  );
  const runtime = await createPiSdkRuntime({
    cwd,
    sessionDirectory,
    modelName: process.env.CAS_PI_MODEL ?? "openai-codex/gpt-5.6-luna",
    memoryEnabled: true,
  });
  try {
    const preference = await runtime.runTurn(
      JSON.stringify({
        trustedContext: {
          receivedAt: "2026-09-02T20:00:00.000Z",
          receivedLocalDateTime: "2026-09-02 13:00:00",
          userTimeZone: "America/Los_Angeles",
        },
        userMessage: "以后回复我时请先给结论，再补必要细节。这是长期偏好。",
      }),
    );
    assert.equal(preference.memoryCandidates?.length, 1);
    assert.equal(preference.memoryCandidates?.[0]?.category, "preference");
    assert.match(preference.memoryCandidates?.[0]?.content ?? "", /先给结论/);

    const transient = await runtime.runTurn(
      JSON.stringify({
        trustedContext: {
          receivedAt: "2026-09-02T20:01:00.000Z",
          receivedLocalDateTime: "2026-09-02 13:01:00",
          userTimeZone: "America/Los_Angeles",
        },
        userMessage: "谢谢。",
      }),
    );
    assert.equal(transient.memoryCandidates, undefined);
    console.log(
      JSON.stringify({
        status: "ok",
        sessionId: runtime.sessionId,
        selectedCategory: preference.memoryCandidates?.[0]?.category,
        transientRetained: false,
      }),
    );
  } finally {
    runtime.dispose();
    await rm(sessionDirectory, { recursive: true, force: true });
  }
}

const executable = process.argv[1];
if (
  executable !== undefined &&
  pathToFileURL(executable).href === import.meta.url
) {
  runMemoryCandidateSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
