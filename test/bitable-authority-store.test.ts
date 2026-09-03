import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bitableValuesEqual,
  createBitableAuthorityStore,
} from "../src/bitable-authority-store.js";

test("Bitable projection snapshots and correction fingerprints survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-bitable-authority-"));
  const databasePath = join(directory, "events.sqlite");
  const first = createBitableAuthorityStore(databasePath);
  first.saveSnapshot({
    tableId: "tbl_items",
    recordId: "rec_item",
    stableKey: "proposal",
    fields: { 状态: ["等待"], 检查点: "2026-09-04T09:00:00+08:00" },
    projectedAt: "2026-09-03T01:00:00.000Z",
  });
  assert.equal(
    first.rememberCorrection({
      fingerprint: "fingerprint-1",
      tableId: "tbl_items",
      recordId: "rec_item",
      stableKey: "proposal",
      changedFields: ["状态"],
      observedAt: "2026-09-03T02:00:00.000Z",
    }),
    true,
  );
  assert.equal(
    first.rememberCorrection({
      fingerprint: "fingerprint-1",
      tableId: "tbl_items",
      recordId: "rec_item",
      stableKey: "proposal",
      changedFields: ["状态"],
      observedAt: "2026-09-03T02:00:00.000Z",
    }),
    false,
  );
  first.close();

  const second = createBitableAuthorityStore(databasePath);
  assert.deepEqual(second.getSnapshot("tbl_items", "proposal")?.fields, {
    状态: ["等待"],
    检查点: "2026-09-04T09:00:00+08:00",
  });
  second.close();
  await rm(directory, { recursive: true, force: true });
});

test("Bitable value comparison ignores equivalent timestamps and link order", () => {
  assert.equal(
    bitableValuesEqual(
      "2026-09-04T09:00:00+08:00",
      "2026-09-04T01:00:00.000Z",
    ),
    true,
  );
  assert.equal(
    bitableValuesEqual([{ id: "rec_2" }, { id: "rec_1" }], [
      { id: "rec_1" },
      { id: "rec_2" },
    ]),
    true,
  );
});
