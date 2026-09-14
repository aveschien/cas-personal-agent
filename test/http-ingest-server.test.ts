import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChannelEvent, IngestResult } from "../src/development-agent.js";
import { createDevelopmentAgent } from "../src/development-agent.js";
import {
  canonicalizeGrokSourceMessageId,
  createHttpIngestServer,
  parseIngestRequest,
} from "../src/http-ingest-server.js";
import type {
  IncomingChannelMessage,
  LarkEventChannel,
} from "../src/lark-event-channel.js";
import { createLiveService } from "../src/live-service.js";

const ingestToken = "test-ingest-token";

async function startedServer(
  ingest: (event: ChannelEvent) => Promise<IngestResult>,
) {
  const server = createHttpIngestServer({
    host: "127.0.0.1",
    port: 0,
    token: ingestToken,
    ingest,
    clock: () => "2026-09-14T08:00:00.000Z",
  });
  await server.start();
  const url = server.url();
  assert.ok(url);
  return { server, url };
}

function ingestBody(overrides: Record<string, unknown> = {}) {
  return {
    sourceMessageId: "grok-msg-1",
    receivedAt: "2026-09-14T08:00:00.000Z",
    userId: "ou_authorized",
    rawText: "从 Grok 记下报价页",
    rawPayload: { channel: "grok" },
    ...overrides,
  };
}

async function postIngest(
  url: string,
  options: {
    readonly token?: string | undefined;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  if (options.token !== undefined) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  return fetch(`${url}/v1/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? ingestBody()),
  });
}

test("parseIngestRequest marks HTTP traffic as grok without requiring Feishu fields", () => {
  const event = parseIngestRequest(
    ingestBody({ rawPayload: { client: "grok-bot" } }),
    () => "2026-09-14T08:01:00.000Z",
  );
  assert.equal(event.source, "grok");
  assert.equal(event.sourceMessageId, "grok-msg-1");
  assert.deepEqual(event.rawPayload, {
    client: "grok-bot",
    channel: "grok",
  });
  assert.equal(
    canonicalizeGrokSourceMessageId("om_feishu_looking"),
    "grok:om_feishu_looking",
  );
  assert.equal(canonicalizeGrokSourceMessageId("grok:already"), "grok:already");
  const prefixed = parseIngestRequest(
    ingestBody({ sourceMessageId: "om_collision" }),
    () => "2026-09-14T08:01:00.000Z",
  );
  assert.equal(prefixed.sourceMessageId, "grok:om_collision");
});

test("Grok ingest IDs do not collide with Feishu source_message_id values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-http-ingest-id-"));
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["ou_authorized"],
    interpreter: {
      interpret: async () => ({
        changes: [],
        acknowledgement: "ok",
      }),
    },
    stateAdapter: { project: async () => undefined },
  });
  try {
    await agent.ingest({
      sourceMessageId: "om_shared",
      receivedAt: "2026-09-14T08:00:00.000Z",
      userId: "ou_authorized",
      rawText: "飞书原话",
      rawPayload: {},
    });
    const grok = parseIngestRequest(
      ingestBody({ sourceMessageId: "om_shared", rawText: "Grok 原话" }),
      () => "2026-09-14T08:00:00.000Z",
    );
    await agent.ingest(grok);
    assert.equal(agent.getEvent("om_shared")?.source, "feishu");
    assert.equal(agent.getEvent("om_shared")?.rawText, "飞书原话");
    assert.equal(agent.getEvent("grok:om_shared")?.source, "grok");
    assert.equal(agent.getEvent("grok:om_shared")?.rawText, "Grok 原话");
  } finally {
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP ingest rejects a missing or wrong bearer token", async () => {
  const ingested: ChannelEvent[] = [];
  const { server, url } = await startedServer(async (event) => {
    ingested.push(event);
    return { status: "completed", acknowledgement: "should not run" };
  });

  try {
    const missing = await postIngest(url, { token: undefined });
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "unauthorized" });

    const wrong = await postIngest(url, { token: "other-token" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "unauthorized" });
    assert.deepEqual(ingested, []);
  } finally {
    await server.stop();
  }
});

test("HTTP ingest rejects an allowlisted-unauthorized user without calling Feishu", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-http-ingest-authz-"));
  const replies: string[] = [];
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["ou_authorized"],
    interpreter: {
      interpret: async () => {
        assert.fail("allowlist rejection must not reach interpretation");
      },
    },
    stateAdapter: {
      project: async () => {
        assert.fail("allowlist rejection must not reach projection");
      },
    },
  });
  const { server, url } = await startedServer((event) => agent.ingest(event));

  try {
    const response = await postIngest(url, {
      token: ingestToken,
      body: ingestBody({ userId: "ou_stranger" }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      status: "rejected",
      acknowledgement: "这个 Bot 仅供已授权用户使用。",
    });
    assert.equal(agent.getEvent("grok-msg-1"), undefined);
    assert.deepEqual(replies, []);
  } finally {
    await server.stop();
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP ingest returns a JSON acknowledgement for Grok traffic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-http-ingest-ok-"));
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["ou_authorized"],
    interpreter: {
      interpret: async () => ({
        changes: [],
        acknowledgement: "已从 Grok 记下报价页。",
      }),
    },
    stateAdapter: {
      project: async () => undefined,
    },
  });
  const { server, url } = await startedServer((event) => agent.ingest(event));

  try {
    const response = await postIngest(url, { token: ingestToken });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "completed",
      acknowledgement: "已从 Grok 记下报价页。",
    });
    assert.equal(agent.getEvent("grok-msg-1")?.source, "grok");
    assert.equal(
      agent.getEvent("grok-msg-1")?.acknowledgement,
      "已从 Grok 记下报价页。",
    );
  } finally {
    await server.stop();
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live service keeps Feishu replies while Grok ingest is JSON-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-http-ingest-live-"));
  let handler:
    | ((message: IncomingChannelMessage) => Promise<void>)
    | undefined;
  const replies: Array<{ messageId: string; text: string }> = [];
  const channel: LarkEventChannel = {
    start: async (onMessage) => {
      handler = onMessage;
    },
    stop: async () => undefined,
    waitForExit: () => new Promise<void>(() => undefined),
    status: () => (handler === undefined ? "stopped" : "running"),
  };
  const service = await createLiveService(
    {
      cwd: directory,
      databasePath: join(directory, "events.sqlite"),
      allowedUserIds: ["ou_authorized"],
      piSessionDirectory: join(directory, "pi-sessions"),
      piModel: "openai-codex/gpt-5.6-luna",
      bitableBaseToken: "bas_state",
      bitableTables: {
        projects: "tbl_projects",
        items: "tbl_items",
        actionLinks: "tbl_actions",
      },
      memory: {
        enabled: false,
        baseUrl: "http://127.0.0.1:8888",
        bankId: "cas-personal-agent",
        recallTimeoutMs: 2_000,
        recallMaxResults: 5,
        recallMaxTokens: 800,
      },
      messageBatching: {
        enabled: false,
        settleMs: 8_000,
        maxWaitMs: 30_000,
      },
      httpIngest: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        token: ingestToken,
      },
    },
    {
      channel,
      replies: {
        reply: async (request) => {
          replies.push({ messageId: request.messageId, text: request.text });
        },
      },
      runtimeFactory: async () => ({
        sessionId: "pi-http-ingest",
        sessionPath: join(directory, "pi-http-ingest.jsonl"),
        runTurn: async (prompt) => ({
          changes: [],
          acknowledgement: `Pi 回复：${prompt}`,
        }),
        dispose: () => undefined,
      }),
      stateProjector: { project: async () => undefined },
    },
  );

  try {
    await service.start();
    assert.ok(handler);
    const ingestUrl = service.httpIngestUrl();
    assert.ok(ingestUrl);
    assert.match(ingestUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    await handler({
      event: {
        sourceMessageId: "om_feishu_untouched",
        receivedAt: "2026-09-14T08:10:00.000Z",
        userId: "ou_authorized",
        rawText: "飞书备份入口仍可用",
        rawPayload: { event_id: "delivery-feishu" },
      },
      chatType: "p2p",
      messageType: "text",
      senderType: "user",
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.messageId, "om_feishu_untouched");
    assert.match(replies[0]?.text ?? "", /飞书备份入口仍可用/);

    const grok = await postIngest(ingestUrl, {
      token: ingestToken,
      body: ingestBody({
        sourceMessageId: "grok-live-1",
        rawText: "Grok 注入同一条流水线",
      }),
    });
    assert.equal(grok.status, 200);
    const body = (await grok.json()) as { status: string; acknowledgement: string };
    assert.equal(body.status, "completed");
    assert.match(body.acknowledgement, /Grok 注入同一条流水线/);
    assert.equal(replies.length, 1);
    assert.equal(
      replies.some((reply) => reply.messageId === "grok-live-1"),
      false,
    );
  } finally {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP ingest returns 404, 405, and 413 for unmatched requests", async () => {
  const { server, url } = await startedServer(async () => {
    assert.fail("invalid HTTP requests must not reach ingest");
  });
  try {
    const missing = await fetch(`${url}/v2/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ingestBody()),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });

    const wrongMethod = await fetch(`${url}/v1/ingest`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ingestToken}` },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    assert.deepEqual(await wrongMethod.json(), { error: "method_not_allowed" });

    const tooLarge = await fetch(`${url}/v1/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestToken}`,
        "Content-Type": "application/json",
      },
      body: "x".repeat(1_048_576 + 1),
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: "payload_too_large" });
  } finally {
    await server.stop();
  }
});

function liveIngestConfig(directory: string, port: number, queueWaitMs?: number) {
  return {
    cwd: directory,
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["ou_authorized"],
    piSessionDirectory: join(directory, "pi-sessions"),
    piModel: "openai-codex/gpt-5.6-luna",
    bitableBaseToken: "bas_state",
    bitableTables: {
      projects: "tbl_projects",
      items: "tbl_items",
      actionLinks: "tbl_actions",
    },
    memory: {
      enabled: false as const,
      baseUrl: "http://127.0.0.1:8888",
      bankId: "cas-personal-agent",
      recallTimeoutMs: 2_000,
      recallMaxResults: 5,
      recallMaxTokens: 800,
    },
    messageBatching: {
      enabled: false,
      settleMs: 8_000,
      maxWaitMs: 30_000,
    },
    httpIngest: {
      enabled: true as const,
      host: "127.0.0.1",
      port,
      token: ingestToken,
      ...(queueWaitMs === undefined ? {} : { queueWaitMs }),
    },
  };
}

function fakeLarkChannel(): {
  readonly channel: LarkEventChannel;
  readonly handler: () =>
    | ((message: IncomingChannelMessage) => Promise<void>)
    | undefined;
} {
  let handler:
    | ((message: IncomingChannelMessage) => Promise<void>)
    | undefined;
  return {
    channel: {
      start: async (onMessage) => {
        handler = onMessage;
      },
      stop: async () => undefined,
      waitForExit: () => new Promise<void>(() => undefined),
      status: () => (handler === undefined ? "stopped" : "running"),
    },
    handler: () => handler,
  };
}

test("HTTP ingest bind failure leaves Feishu live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-http-ingest-bind-"));
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", () => resolve());
  });
  const address = occupied.address();
  assert.ok(address !== null && typeof address !== "string");
  const replies: string[] = [];
  const errors: string[] = [];
  const lark = fakeLarkChannel();
  const service = await createLiveService(
    liveIngestConfig(directory, address.port),
    {
      channel: lark.channel,
      replies: {
        reply: async (request) => {
          replies.push(request.text);
        },
      },
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
      runtimeFactory: async () => ({
        sessionId: "pi-http-bind",
        sessionPath: join(directory, "pi-http-bind.jsonl"),
        runTurn: async (prompt) => ({
          changes: [],
          acknowledgement: `Pi 回复：${prompt}`,
        }),
        dispose: () => undefined,
      }),
      stateProjector: { project: async () => undefined },
    },
  );

  try {
    await service.start();
    const handler = lark.handler();
    assert.ok(handler);
    assert.equal(service.httpIngestUrl(), undefined);
    assert.equal(
      errors.some((message) => message.includes("HTTP ingest failed to start")),
      true,
    );
    await handler({
      event: {
        sourceMessageId: "om_bind_failure_feishu",
        receivedAt: "2026-09-14T08:20:00.000Z",
        userId: "ou_authorized",
        rawText: "飞书在 HTTP 绑定失败后仍可用",
        rawPayload: {},
      },
      chatType: "p2p",
      messageType: "text",
      senderType: "user",
    });
    assert.equal(replies.length, 1);
    assert.match(replies[0] ?? "", /飞书在 HTTP 绑定失败后仍可用/);
  } finally {
    await service.stop();
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("Feishu and HTTP ingest never overlap Pi turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-http-ingest-serial-"));
  const replies: string[] = [];
  const lark = fakeLarkChannel();
  let inflight = 0;
  let maxInflight = 0;
  const feishuTurnStarted = Promise.withResolvers<void>();
  const holdFeishu = Promise.withResolvers<void>();
  const service = await createLiveService(liveIngestConfig(directory, 0), {
    channel: lark.channel,
    replies: {
      reply: async (request) => {
        replies.push(request.text);
      },
    },
    runtimeFactory: async () => ({
      sessionId: "pi-http-serial",
      sessionPath: join(directory, "pi-http-serial.jsonl"),
      runTurn: async (prompt) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        if (prompt.includes("飞书先占用回合")) {
          feishuTurnStarted.resolve();
          await holdFeishu.promise;
        }
        inflight -= 1;
        return { changes: [], acknowledgement: `Pi 回复：${prompt}` };
      },
      dispose: () => undefined,
    }),
    stateProjector: { project: async () => undefined },
  });

  try {
    await service.start();
    const handler = lark.handler();
    const ingestUrl = service.httpIngestUrl();
    assert.ok(handler);
    assert.ok(ingestUrl);

    const feishu = handler({
      event: {
        sourceMessageId: "om_serial_feishu",
        receivedAt: "2026-09-14T08:30:00.000Z",
        userId: "ou_authorized",
        rawText: "飞书先占用回合",
        rawPayload: {},
      },
      chatType: "p2p",
      messageType: "text",
      senderType: "user",
    });
    await feishuTurnStarted.promise;
    const grok = postIngest(ingestUrl, {
      token: ingestToken,
      body: ingestBody({
        sourceMessageId: "grok-serial-1",
        rawText: "Grok 排队等待",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(maxInflight, 1);
    holdFeishu.resolve();
    await feishu;
    const grokResponse = await grok;
    assert.equal(grokResponse.status, 200);
    const body = (await grokResponse.json()) as {
      status: string;
      acknowledgement: string;
    };
    assert.equal(body.status, "completed");
    assert.match(body.acknowledgement, /Grok 排队等待/);
    assert.equal(replies.length, 1);
    assert.equal(maxInflight, 1);
  } finally {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
