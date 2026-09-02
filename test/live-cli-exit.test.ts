import assert from "node:assert/strict";
import test from "node:test";

import { runLiveCli } from "../src/live-cli.js";

test("the live CLI stops and fails when its event consumer exits", async () => {
  const lifecycle: string[] = [];
  await assert.rejects(
    runLiveCli({
      cwd: "/srv/cas-personal-agent",
      environment: { CAS_ALLOWED_USER_IDS: "ou_owner" },
      waitForShutdown: new Promise<void>(() => undefined),
      serviceFactory: async () => ({
        start: async () => {
          lifecycle.push("start");
        },
        stop: async () => {
          lifecycle.push("stop");
        },
        waitForExit: async () => {
          throw new Error("lark-cli exited unexpectedly (code 23)");
        },
      }),
      log: () => undefined,
    }),
    /lark-cli exited unexpectedly \(code 23\)/,
  );
  assert.deepEqual(lifecycle, ["start", "stop"]);
});
