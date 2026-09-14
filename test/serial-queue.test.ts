import assert from "node:assert/strict";
import test from "node:test";

import {
  createSerialQueue,
  IngestBusyError,
} from "../src/serial-queue.js";

test("the serial queue runs work one at a time", async () => {
  const queue = createSerialQueue();
  let inflight = 0;
  let maxInflight = 0;
  const hold = Promise.withResolvers<void>();

  const first = queue.run(async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await hold.promise;
    inflight -= 1;
    return "first";
  });
  const second = queue.run(async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    inflight -= 1;
    return "second";
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(maxInflight, 1);
  hold.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(maxInflight, 1);
});

test("a waiting caller can time out without blocking the current turn", async () => {
  const queue = createSerialQueue();
  const hold = Promise.withResolvers<void>();
  const first = queue.run(async () => {
    await hold.promise;
    return "first";
  });
  await assert.rejects(
    queue.run(async () => "second", { waitTimeoutMs: 20 }),
    (error: unknown) => {
      assert.ok(error instanceof IngestBusyError);
      assert.equal(error.waitTimeoutMs, 20);
      return true;
    },
  );
  hold.resolve();
  assert.equal(await first, "first");
  assert.equal(await queue.run(async () => "third"), "third");
});

test("a failed turn does not stick the queue", async () => {
  const queue = createSerialQueue();
  await assert.rejects(queue.run(async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(await queue.run(async () => "recovered"), "recovered");
});
