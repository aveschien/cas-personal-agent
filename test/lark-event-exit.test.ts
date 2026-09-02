import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createLarkEventChannel } from "../src/lark-event-channel.js";

test("an unexpected lark-cli exit is observable by the service", async () => {
  const channel = createLarkEventChannel({
    command: process.execPath,
    args: [join(process.cwd(), "dist/test/fixtures/fake-lark-event-exit.js")],
  });

  await channel.start(async () => undefined);
  await assert.rejects(
    channel.waitForExit?.(),
    /lark-cli exited unexpectedly \(code 23\)/,
  );
  assert.equal(channel.status(), "stopped");
});
