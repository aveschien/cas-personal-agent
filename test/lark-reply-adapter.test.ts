import assert from "node:assert/strict";
import test from "node:test";

import {
  createLarkReplyAdapter,
  type CommandResult,
} from "../src/lark-reply-adapter.js";

test("Markdown-looking replies use Lark post rendering instead of literal text", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const adapter = createLarkReplyAdapter({
    runner: {
      run: async (command, args): Promise<CommandResult> => {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  await adapter.reply({
    messageId: "om_markdown",
    text: "已完成 **报价页**，详见 [项目文档](https://example.com/doc)。",
    idempotencyKey: "reply:om_markdown",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args.includes("--text"), false);
  const markdownIndex = calls[0]?.args.indexOf("--markdown") ?? -1;
  assert.equal(
    calls[0]?.args[markdownIndex + 1],
    "已完成 **报价页**，详见 [项目文档](https://example.com/doc)。",
  );
});
