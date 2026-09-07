import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkingSetStore } from "../src/working-set-store.js";

test("Working Set keeps bounded recent references and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-working-set-"));
  const databasePath = join(directory, "events.sqlite");
  let store = createWorkingSetStore(databasePath, 3);
  try {
    store.observeOperations("cas-main", [{ kind: "upsert_project", projectKey: "hospital-quote", name: "院方报价", status: "tracking" }], "2026-09-07T00:58:00.000Z");
    store.observeOperations("cas-main", [{ kind: "upsert_project", projectKey: "vendor-quote", name: "供应商报价", status: "tracking" }], "2026-09-07T00:59:00.000Z");
    store.observeOperations("cas-main", [{ kind: "upsert_item", itemKey: "quote-page", title: "修改报价页", type: "task", status: "in_progress", projectKey: "hospital-quote" }], "2026-09-07T01:00:00.000Z");
    store.observeOperations("cas-main", [{ kind: "clarify", question: "你指院方报价还是供应商报价？", reason: "两个近期项目都匹配报价" }], "2026-09-07T01:01:00.000Z");
    assert.equal(store.snapshot("cas-main").length, 3);
    assert.equal(store.snapshot("cas-main")[0]?.entityType, "question");

    store.close();
    store = createWorkingSetStore(databasePath, 3);
    const restored = store.snapshot("cas-main");
    assert.equal(restored.length, 3);
    assert.equal(restored.some((entry) => entry.entityKey === "quote-page"), true);
    assert.equal(store.referenceCandidates("cas-main", "继续刚才那个", 2).length, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
