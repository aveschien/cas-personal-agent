import assert from "node:assert/strict";
import test from "node:test";

import {
  createHindsightMemoryAdapter,
  memoryOperationId,
  validateMemoryCandidate,
  type HindsightClientBoundary,
} from "../src/memory.js";

test("the Hindsight adapter bounds recall and preserves source provenance", async () => {
  const calls: unknown[] = [];
  const client: HindsightClientBoundary = {
    recall: async (bankId, query, options) => {
      calls.push({ bankId, query, options });
      return {
        results: [
          {
            id: "memory-1",
            text: "用户偏好先给结论。",
            type: "world",
            document_id: "cas:om_old:reply-style",
            mentioned_at: "2026-09-01T10:00:00Z",
            metadata: { source_event_id: "om_old" },
          },
          {
            id: "memory-2",
            text: "第二条不应超过结果上限。",
          },
        ],
      };
    },
    retain: async () => ({ success: true }),
    getOperationStatus: async () => ({
      status: "completed",
      errorMessage: null,
    }),
  };
  const memory = createHindsightMemoryAdapter({
    baseUrl: "http://127.0.0.1:8888",
    bankId: "cas-personal-agent",
    client,
  });
  const controller = new AbortController();

  assert.deepEqual(
    await memory.recall({
      query: "我喜欢怎样的回复？",
      maxResults: 1,
      maxTokens: 400,
      signal: controller.signal,
    }),
    [
      {
        id: "memory-1",
        text: "用户偏好先给结论。",
        type: "world",
        source: {
          system: "hindsight",
          documentId: "cas:om_old:reply-style",
          sourceEventId: "om_old",
          mentionedAt: "2026-09-01T10:00:00Z",
        },
      },
    ],
  );
  assert.equal(calls.length, 1);
});

test("retain uses stable Hindsight idempotency and concise provenance", async () => {
  const calls: unknown[] = [];
  const client: HindsightClientBoundary = {
    recall: async () => ({ results: [] }),
    retain: async (...args) => {
      calls.push(args);
      return { success: true };
    },
    getOperationStatus: async (bankId, operationId) => {
      calls.push(["operation", bankId, operationId]);
      return { status: "completed", errorMessage: null };
    },
  };
  const memory = createHindsightMemoryAdapter({
    baseUrl: "http://127.0.0.1:8888",
    bankId: "cas-personal-agent",
    client,
  });
  const operationId = memoryOperationId("om_memory", "reply-style");
  const controller = new AbortController();

  await memory.retain({
    candidate: {
      key: "reply-style",
      category: "preference",
      content: "用户偏好简短回复，并先给结论。",
    },
    sourceEventId: "om_memory",
    occurredAt: "2026-09-02T12:00:00Z",
    operationId,
    signal: controller.signal,
  });

  assert.deepEqual(calls, [
    [
      "cas-personal-agent",
      "用户偏好简短回复，并先给结论。",
      {
        timestamp: "2026-09-02T12:00:00Z",
        context: "cas:preference",
        metadata: {
          source: "feishu",
          source_event_id: "om_memory",
          category: "preference",
          candidate_key: "reply-style",
        },
        documentId: "cas:om_memory:reply-style",
        async: true,
        operationId,
        tags: ["category:preference"],
        observationScopes: "shared",
        signal: controller.signal,
      },
    ],
    ["operation", "cas-personal-agent", operationId],
  ]);
  assert.equal(operationId, memoryOperationId("om_memory", "reply-style"));
  assert.throws(
    () =>
      validateMemoryCandidate({
        key: "secret",
        category: "preference",
        content: "api_key=super-secret-value-123",
      }),
    /secret-like material/,
  );
});

test("retain reports a failed asynchronous Hindsight operation", async () => {
  const client: HindsightClientBoundary = {
    recall: async () => ({ results: [] }),
    retain: async () => ({ success: true }),
    getOperationStatus: async () => ({
      status: "failed",
      errorMessage: "embedding provider unavailable",
    }),
  };
  const memory = createHindsightMemoryAdapter({
    baseUrl: "http://127.0.0.1:8888",
    bankId: "cas-personal-agent",
    client,
  });

  await assert.rejects(
    memory.retain({
      candidate: {
        key: "reply-style",
        category: "preference",
        content: "用户偏好先给结论。",
      },
      sourceEventId: "om_failed",
      occurredAt: "2026-09-02T12:00:00Z",
      operationId: memoryOperationId("om_failed", "reply-style"),
      signal: new AbortController().signal,
    }),
    /embedding provider unavailable/,
  );
});
