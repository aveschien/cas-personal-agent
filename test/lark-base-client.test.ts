import assert from "node:assert/strict";
import test from "node:test";

import type { CommandRunner } from "../src/lark-reply-adapter.js";
import { createLarkBaseClient } from "../src/lark-base-client.js";

test("the Lark Base client performs exact-key lookup, create, and delta update", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const results = [
    {
      ok: true,
      identity: "user",
      data: {
        data: [["proposal-feedback", "等待"]],
        fields: ["item_key", "状态"],
        record_id_list: ["rec_item_1"],
        has_more: false,
      },
    },
    {
      ok: true,
      identity: "user",
      data: {
        data: [["proposal-feedback"]],
        fields: ["item_key"],
        record_id_list: ["rec_item_1"],
      },
    },
    {
      ok: true,
      identity: "user",
      data: { record_id_list: ["rec_item_2"] },
    },
    { ok: true, identity: "user", data: {} },
  ];
  const runner: CommandRunner = {
    run: async (command, args) => {
      mutableCalls.push([command, ...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify(results.shift()),
        stderr: "",
      };
    },
  };
  const client = createLarkBaseClient({
    baseToken: "bas_test",
    command: "lark-cli",
    runner,
  });

  assert.deepEqual(await client.list("tbl_items", ["item_key", "状态"]), [
    {
      recordId: "rec_item_1",
      fields: { item_key: "proposal-feedback", 状态: "等待" },
    },
  ]);

  assert.deepEqual(
    await client.findByKey("tbl_items", "item_key", "proposal-feedback"),
    {
      recordId: "rec_item_1",
      fields: { item_key: "proposal-feedback" },
    },
  );
  assert.deepEqual(
    await client.create(
      "tbl_items",
      "item_key",
      "new-item",
      { 事项: "新事项", item_key: "new-item" },
    ),
    {
      recordId: "rec_item_2",
      fields: { 事项: "新事项", item_key: "new-item" },
    },
  );
  await client.update("tbl_items", "rec_item_2", { 状态: ["等待"] });

  assert.deepEqual(calls[0], [
    "lark-cli",
    "base",
    "+record-list",
    "--base-token",
    "bas_test",
    "--table-id",
    "tbl_items",
    "--field-id",
    "item_key",
    "--field-id",
    "状态",
    "--offset",
    "0",
    "--limit",
    "200",
    "--format",
    "json",
    "--as",
    "user",
  ]);
  assert.deepEqual(calls[1], [
    "lark-cli",
    "base",
    "+record-search",
    "--base-token",
    "bas_test",
    "--table-id",
    "tbl_items",
    "--json",
    JSON.stringify({
      keyword: "proposal-feedback",
      search_fields: ["item_key"],
      select_fields: ["item_key"],
      filter: {
        logic: "and",
        conditions: [["item_key", "==", "proposal-feedback"]],
      },
      limit: 2,
    }),
    "--format",
    "json",
    "--as",
    "user",
  ]);
  assert.equal(calls[2]?.[2], "+record-batch-create");
  assert.equal(calls[3]?.[2], "+record-batch-update");
});

test("the Lark Base client rejects duplicate stable keys", async () => {
  const client = createLarkBaseClient({
    baseToken: "bas_test",
    runner: {
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            data: [["same"], ["same"]],
            fields: ["item_key"],
            record_id_list: ["rec_1", "rec_2"],
          },
        }),
        stderr: "",
      }),
    },
  });
  await assert.rejects(
    client.findByKey("tbl_items", "item_key", "same"),
    /duplicate item_key same/,
  );
});

test("the Lark Base client preserves a safe external error code", async () => {
  const client = createLarkBaseClient({
    baseToken: "bas_test",
    runner: {
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: '{"code":800030005,"msg":"not_found"}',
      }),
    },
  });
  await assert.rejects(
    client.create("tbl_projects", "project_key", "project", {}),
    /record create failed \(code 800030005\)/,
  );
});
