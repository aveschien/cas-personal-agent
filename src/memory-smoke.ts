import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createHindsightMemoryAdapter,
  memoryOperationId,
} from "./memory.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runMemorySmoke(): Promise<void> {
  assert.equal(process.env.MEMORY_ENABLED, "true", "MEMORY_ENABLED must be true");
  const baseUrl = required("HINDSIGHT_BASE_URL");
  const productionBank = required("HINDSIGHT_BANK_ID");
  const bankId = process.env.HINDSIGHT_SMOKE_BANK_ID ?? `${productionBank}-smoke`;
  const sourceEventId = `dev-memory-smoke-${randomUUID()}`;
  const candidate = {
    key: "conclusion-first",
    category: "preference" as const,
    content: "记忆烟测用户明确偏好：回复时先给结论，再给必要细节。",
  };
  const retainAdapter = createHindsightMemoryAdapter({ baseUrl, bankId });
  await retainAdapter.retain({
    candidate,
    sourceEventId,
    occurredAt: new Date().toISOString(),
    operationId: memoryOperationId(sourceEventId, candidate.key),
    signal: AbortSignal.timeout(60_000),
  });

  const deadline = Date.now() + 120_000;
  let recalled = false;
  let resultCount = 0;
  while (Date.now() < deadline) {
    const freshSessionAdapter = createHindsightMemoryAdapter({ baseUrl, bankId });
    const results = await freshSessionAdapter.recall({
      query: "记忆烟测用户希望回复采用什么顺序？",
      maxResults: 5,
      maxTokens: 800,
      signal: AbortSignal.timeout(10_000),
    });
    resultCount = results.length;
    if (results.some((result) => /先给结论/.test(result.text))) {
      recalled = true;
      break;
    }
    await delay(3_000);
  }
  assert.equal(recalled, true, "cross-session Hindsight recall did not find retained preference");
  console.log(
    JSON.stringify({
      status: "ok",
      bankId,
      sourceEventId,
      resultCount,
      crossSessionRecall: true,
    }),
  );
}

const executable = process.argv[1];
if (
  executable !== undefined &&
  pathToFileURL(executable).href === import.meta.url
) {
  runMemorySmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
