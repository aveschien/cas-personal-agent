import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadLiveConfig } from "../src/live-config.js";

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
    },
  );

  assert.throws(
    () => loadLiveConfig({}, cwd),
    /CAS_ALLOWED_USER_IDS must contain at least one Feishu user ID/,
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
