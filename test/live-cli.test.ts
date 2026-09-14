import assert from "node:assert/strict";
import test from "node:test";

import type { LiveService } from "../src/live-service.js";
import { runLiveCli } from "../src/live-cli.js";

test("the live CLI starts once and closes resources after shutdown", async () => {
  const shutdown = Promise.withResolvers<void>();
  const lifecycle: string[] = [];
  const logs: string[] = [];
  const service: LiveService = {
    start: async () => {
      lifecycle.push("start");
    },
    stop: async () => {
      lifecycle.push("stop");
    },
    waitForExit: () => new Promise<void>(() => undefined),
    httpIngestUrl: () => undefined,
  };

  const running = runLiveCli({
    cwd: "/srv/cas-personal-agent",
    environment: {
      CAS_ALLOWED_USER_IDS: "ou_owner",
      CAS_BITABLE_BASE_TOKEN: "bas_state",
      CAS_BITABLE_PROJECTS_TABLE_ID: "tbl_projects",
      CAS_BITABLE_ITEMS_TABLE_ID: "tbl_items",
      CAS_BITABLE_ACTION_LINKS_TABLE_ID: "tbl_actions",
    },
    waitForShutdown: shutdown.promise,
    serviceFactory: async (config) => {
      assert.deepEqual(config.allowedUserIds, ["ou_owner"]);
      return service;
    },
    log: (message) => logs.push(message),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, ["start"]);
  shutdown.resolve();
  await running;

  assert.deepEqual(lifecycle, ["start", "stop"]);
  assert.deepEqual(logs, [
    "[cas] ready channel=lark runtime=pi",
    "[cas] stopped",
  ]);
});
