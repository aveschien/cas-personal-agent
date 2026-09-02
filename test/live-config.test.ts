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
      },
      cwd,
    ),
    {
      cwd,
      databasePath: resolve(cwd, "state/events.sqlite"),
      allowedUserIds: ["ou_one", "ou_two"],
      piSessionDirectory: resolve(cwd, "state/pi-sessions"),
      piModel: "openai-codex/gpt-5.6-luna",
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
