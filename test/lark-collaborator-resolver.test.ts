import assert from "node:assert/strict";
import test from "node:test";

import { createLarkCollaboratorResolver } from "../src/lark-collaborator-resolver.js";

test("a collaborator name is resolved read-only through the user identity", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const resolver = createLarkCollaboratorResolver({
    runner: {
      run: async (command, args) => {
        calls.push({ command, args });
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            identity: "user",
            data: {
              users: [
                {
                  open_id: "ou_xiaowang",
                  localized_name: "小王",
                  department: "研发-平台",
                  enterprise_email: "wang@example.com",
                  is_cross_tenant: false,
                },
              ],
            },
          }),
        };
      },
    },
  });

  assert.deepEqual(await resolver.resolve(" 小王 "), [
    {
      openId: "ou_xiaowang",
      name: "小王",
      department: "研发-平台",
      enterpriseEmail: "wang@example.com",
      isCrossTenant: false,
    },
  ]);
  assert.deepEqual(calls, [
    {
      command: "lark-cli",
      args: [
        "contact",
        "+search-user",
        "--query",
        "小王",
        "--page-size",
        "10",
        "--as",
        "user",
        "--json",
      ],
    },
  ]);
});

test("collaborator lookup rejects an invalid CLI envelope", async () => {
  const resolver = createLarkCollaboratorResolver({
    runner: {
      run: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ ok: false }),
      }),
    },
  });
  await assert.rejects(
    resolver.resolve("小王"),
    /invalid collaborator search result/,
  );
});
