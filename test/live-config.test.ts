import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadLiveConfig, isLoopbackHost } from "../src/live-config.js";

test("live config resolves durable paths and requires an explicit allowlist", () => {
  const cwd = "/srv/cas-personal-agent";
  assert.deepEqual(
    loadLiveConfig(
      {
        CAS_ALLOWED_USER_IDS: " ou_one,ou_two,ou_one ",
        CAS_DATABASE_PATH: "./state/events.sqlite",
        CAS_PI_SESSION_DIR: "./state/pi-sessions",
        CAS_PI_MODEL: "openai-codex/gpt-5.6-luna",
        CAS_BITABLE_BASE_TOKEN: "bas_state",
        CAS_BITABLE_PROJECTS_TABLE_ID: "tbl_projects",
        CAS_BITABLE_ITEMS_TABLE_ID: "tbl_items",
        CAS_BITABLE_ACTION_LINKS_TABLE_ID: "tbl_actions",
      },
      cwd,
    ),
    {
      cwd,
      databasePath: resolve(cwd, "state/events.sqlite"),
      allowedUserIds: ["ou_one", "ou_two"],
      piSessionDirectory: resolve(cwd, "state/pi-sessions"),
      piModel: "openai-codex/gpt-5.6-luna",
      piThinkingLevel: "max",
      bitableBaseToken: "bas_state",
      bitableTables: {
        projects: "tbl_projects",
        items: "tbl_items",
        actionLinks: "tbl_actions",
      },
      memory: {
        enabled: true,
        baseUrl: "http://127.0.0.1:8888",
        bankId: "cas-personal-agent",
        recallTimeoutMs: 2_000,
        recallMaxResults: 5,
        recallMaxTokens: 800,
      },
      personalActions: { enabled: false },
      collaborativeActions: { enabled: false },
      httpIngest: { enabled: false },
      messageBatching: {
        enabled: true,
        settleMs: 8_000,
        maxWaitMs: 30_000,
      },
      externalSync: {
        intervalMs: 60_000,
        requestBudget: 5,
        timeoutMs: 5_000,
      },
    },
  );

  assert.throws(
    () => loadLiveConfig({}, cwd),
    /CAS_ALLOWED_USER_IDS must contain at least one Feishu user ID/,
  );
});

test("Feishu Task writes require an explicit enable flag", () => {
  const config = loadLiveConfig(
    {
      CAS_ALLOWED_USER_IDS: "ou_one",
      CAS_BITABLE_BASE_TOKEN: "bas_state",
      CAS_BITABLE_PROJECTS_TABLE_ID: "tbl_projects",
      CAS_BITABLE_ITEMS_TABLE_ID: "tbl_items",
      CAS_BITABLE_ACTION_LINKS_TABLE_ID: "tbl_actions",
      FEISHU_TASK_ENABLED: "true",
    },
    "/srv/cas-personal-agent",
  );
  assert.deepEqual(config.collaborativeActions, { enabled: true });
  assert.throws(
    () =>
      loadLiveConfig(
        {
          CAS_ALLOWED_USER_IDS: "ou_one",
          CAS_BITABLE_BASE_TOKEN: "bas_state",
          CAS_BITABLE_PROJECTS_TABLE_ID: "tbl_projects",
          CAS_BITABLE_ITEMS_TABLE_ID: "tbl_items",
          CAS_BITABLE_ACTION_LINKS_TABLE_ID: "tbl_actions",
          FEISHU_TASK_ENABLED: "yes",
        },
        "/srv/cas-personal-agent",
      ),
    /FEISHU_TASK_ENABLED must be true or false/,
  );
});

test("live config rejects malformed Pi model identifiers", () => {
  assert.throws(
    () =>
      loadLiveConfig(
        {
          CAS_ALLOWED_USER_IDS: "ou_one",
          CAS_PI_MODEL: "gpt-5.6-luna",
        },
        "/srv/cas-personal-agent",
      ),
    /CAS_PI_MODEL must use provider\/model format/,
  );
});

test("live config accepts an explicit Pi thinking level and validates batching", () => {
  const common = {
    CAS_ALLOWED_USER_IDS: "ou_one",
    CAS_BITABLE_BASE_TOKEN: "bas_state",
    CAS_BITABLE_PROJECTS_TABLE_ID: "tbl_projects",
    CAS_BITABLE_ITEMS_TABLE_ID: "tbl_items",
    CAS_BITABLE_ACTION_LINKS_TABLE_ID: "tbl_actions",
  };
  const config = loadLiveConfig(
    {
      ...common,
      CAS_PI_THINKING_LEVEL: "xhigh",
      CAS_MESSAGE_BATCHING_ENABLED: "false",
      CAS_MESSAGE_SETTLE_MS: "5000",
      CAS_MESSAGE_MAX_WAIT_MS: "20000",
    },
    "/srv/cas-personal-agent",
  );
  assert.equal(config.piThinkingLevel, "xhigh");
  assert.deepEqual(config.messageBatching, {
    enabled: false,
    settleMs: 5_000,
    maxWaitMs: 20_000,
  });
  assert.throws(
    () =>
      loadLiveConfig(
        { ...common, CAS_PI_THINKING_LEVEL: "ultra" },
        "/srv/cas-personal-agent",
      ),
    /CAS_PI_THINKING_LEVEL is invalid/,
  );
  assert.throws(
    () =>
      loadLiveConfig(
        {
          ...common,
          CAS_MESSAGE_SETTLE_MS: "30000",
          CAS_MESSAGE_MAX_WAIT_MS: "8000",
        },
        "/srv/cas-personal-agent",
      ),
    /CAS_MESSAGE_MAX_WAIT_MS must be at least CAS_MESSAGE_SETTLE_MS/,
  );
});

test("TickTick writes require an explicit enable flag and credentials", () => {
  const common = {
    CAS_ALLOWED_USER_IDS: "ou_one",
    CAS_BITABLE_BASE_TOKEN: "bas_state",
    CAS_BITABLE_PROJECTS_TABLE_ID: "tbl_projects",
    CAS_BITABLE_ITEMS_TABLE_ID: "tbl_items",
    CAS_BITABLE_ACTION_LINKS_TABLE_ID: "tbl_actions",
  };
  assert.throws(
    () =>
      loadLiveConfig(
        { ...common, TICKTICK_ENABLED: "true" },
        "/srv/cas-personal-agent",
      ),
    /TICKTICK_API_TOKEN is required/,
  );
  assert.deepEqual(
    loadLiveConfig(
      {
        ...common,
        TICKTICK_ENABLED: "true",
        TICKTICK_API_TOKEN: "secret-token",
        TICKTICK_PROJECT_ID: "project-1",
      },
      "/srv/cas-personal-agent",
    ).personalActions,
    {
      enabled: true,
      apiToken: "secret-token",
      projectId: "project-1",
      baseUrl: "https://api.ticktick.com/open/v1",
    },
  );
  assert.throws(
    () =>
      loadLiveConfig(
        {
          ...common,
          TICKTICK_ENABLED: "true",
          TICKTICK_API_TOKEN: "secret-token",
          TICKTICK_PROJECT_ID: "project-1",
          TICKTICK_BASE_URL: "https://example.com/open/v1",
        },
        "/srv/cas-personal-agent",
      ),
    /official TickTick or Dida365/,
  );
});

test("HTTP ingest is disabled until a token is set and binds loopback by default", () => {
  const common = {
    CAS_ALLOWED_USER_IDS: "ou_one",
    CAS_BITABLE_BASE_TOKEN: "bas_state",
    CAS_BITABLE_PROJECTS_TABLE_ID: "tbl_projects",
    CAS_BITABLE_ITEMS_TABLE_ID: "tbl_items",
    CAS_BITABLE_ACTION_LINKS_TABLE_ID: "tbl_actions",
  };
  assert.deepEqual(
    loadLiveConfig(common, "/srv/cas-personal-agent").httpIngest,
    { enabled: false },
  );
  assert.deepEqual(
    loadLiveConfig(
      { ...common, CAS_INGEST_TOKEN: "  local-ingest-token  " },
      "/srv/cas-personal-agent",
    ).httpIngest,
    {
      enabled: true,
      host: "127.0.0.1",
      port: 8787,
      token: "local-ingest-token",
    },
  );
  assert.deepEqual(
    loadLiveConfig(
      {
        ...common,
        CAS_INGEST_TOKEN: "local-ingest-token",
        CAS_INGEST_HOST: "127.0.0.1",
        CAS_INGEST_PORT: "9876",
      },
      "/srv/cas-personal-agent",
    ).httpIngest,
    {
      enabled: true,
      host: "127.0.0.1",
      port: 9876,
      token: "local-ingest-token",
    },
  );
  assert.throws(
    () =>
      loadLiveConfig(
        {
          ...common,
          CAS_INGEST_TOKEN: "local-ingest-token",
          CAS_INGEST_PORT: "70000",
        },
        "/srv/cas-personal-agent",
      ),
    /CAS_INGEST_PORT must be between 1 and 65535/,
  );
  assert.deepEqual(
    loadLiveConfig(
      {
        ...common,
        CAS_INGEST_TOKEN: "local-ingest-token",
        CAS_INGEST_HOST: "0.0.0.0",
        CAS_INGEST_QUEUE_WAIT_MS: "5000",
      },
      "/srv/cas-personal-agent",
    ).httpIngest,
    {
      enabled: true,
      host: "0.0.0.0",
      port: 8787,
      token: "local-ingest-token",
      queueWaitMs: 5_000,
    },
  );
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});
