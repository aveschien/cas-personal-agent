import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAuthoritativeBitableReader } from "../src/authoritative-bitable-reader.js";
import { createBitableAuthorityStore } from "../src/bitable-authority-store.js";

test("manual Bitable Item edits become authoritative state and one memory candidate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-bitable-reader-"));
  const store = createBitableAuthorityStore(join(directory, "events.sqlite"));
  const itemFields: Record<string, unknown> = {
    item_key: "proposal-feedback",
    事项: "等待方案反馈",
    项目: [{ id: "rec_project" }],
    类型: ["任务"],
    状态: ["等待"],
    下一步: null,
    当前摘要: "方案已发出",
    在等什么: "张总反馈",
    解除条件: "收到明确反馈",
    检查点: "2026-09-04T09:00:00+08:00",
    "条件/预案": "没回复就跟进",
    稍后区: false,
    最近更新: "2026-09-03T01:00:00.000Z",
  };
  const reader = createAuthoritativeBitableReader({
    bitable: {
      list: async (tableId) =>
        tableId === "tbl_projects"
          ? [
              {
                recordId: "rec_project",
                fields: {
                  project_key: "hospital-proposal",
                  项目名: "院方方案",
                  状态: ["在跟"],
                },
              },
            ]
          : [{ recordId: "rec_item", fields: itemFields }],
      findByKey: async () => undefined,
      create: async () => {
        throw new Error("not used");
      },
      update: async () => undefined,
    },
    tables: { projects: "tbl_projects", items: "tbl_items" },
    store,
  });

  const baseline = await reader.reconcile("2026-09-03T01:00:00.000Z");
  assert.equal(baseline.memoryCandidates.length, 0);
  assert.equal(baseline.items.length, 0);
  itemFields.状态 = ["完成"];
  itemFields.下一步 = "归档材料";
  itemFields.最近更新 = "2026-09-03T02:00:00.000Z";

  const corrected = await reader.reconcile("2026-09-03T02:00:00.000Z");
  assert.deepEqual(corrected.items[0], {
    recordId: "rec_item",
    itemKey: "proposal-feedback",
    title: "等待方案反馈",
    projectKey: "hospital-proposal",
    type: "任务",
    status: "完成",
    nextAction: "归档材料",
    summary: "方案已发出",
    waitingFor: "张总反馈",
    releaseCondition: "收到明确反馈",
    checkpointAt: "2026-09-04T09:00:00+08:00",
    contingency: "没回复就跟进",
    parked: false,
    updatedAt: "2026-09-03T02:00:00.000Z",
    inCurrentAttention: false,
    correctedFields: ["状态", "下一步"],
  });
  assert.equal(corrected.memoryCandidates.length, 1);
  assert.match(corrected.memoryCandidates[0]?.content ?? "", /状态=完成/);
  assert.equal(
    (await reader.reconcile("2026-09-03T03:00:00.000Z")).memoryCandidates
      .length,
    0,
  );

  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("manual Bitable Project edits are detected without treating first read as a correction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-project-reader-"));
  const store = createBitableAuthorityStore(join(directory, "events.sqlite"));
  const projectFields: Record<string, unknown> = {
    project_key: "hospital-proposal",
    项目名: "院方方案",
    状态: ["在跟"],
    目标: "完成方案验收",
    阶段: ["方案"],
    当前摘要: "等待反馈",
  };
  const reader = createAuthoritativeBitableReader({
    bitable: {
      list: async (tableId) =>
        tableId === "tbl_projects"
          ? [{ recordId: "rec_project", fields: projectFields }]
          : [],
      findByKey: async () => undefined,
      create: async () => {
        throw new Error("not used");
      },
      update: async () => undefined,
    },
    tables: { projects: "tbl_projects", items: "tbl_items" },
    store,
  });

  assert.equal((await reader.reconcile()).memoryCandidates.length, 0);
  projectFields.阶段 = ["验收"];
  projectFields.当前摘要 = "院方已接受方案";
  const result = await reader.reconcile("2026-09-03T04:00:00.000Z");

  assert.deepEqual(result.projects[0]?.correctedFields, ["阶段", "当前摘要"]);
  assert.equal(result.memoryCandidates.length, 1);
  assert.match(result.memoryCandidates[0]?.content ?? "", /阶段=验收/);

  store.close();
  await rm(directory, { recursive: true, force: true });
});
