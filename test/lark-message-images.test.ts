import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createLarkMessageImageLoader } from "../src/lark-message-images.js";
import type { IncomingChannelMessage } from "../src/lark-event-channel.js";

test("a Feishu image is downloaded with bot identity and returned to Pi", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  let savedPath = "";
  const loader = createLarkMessageImageLoader({
    runner: {
      run: async (command, args) => {
        calls.push({ command, args });
        const outputIndex = args.indexOf("--output");
        savedPath = args[outputIndex + 1] ?? "";
        await writeFile(
          savedPath,
          Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            data: { saved_path: savedPath, size_bytes: 8 },
          }),
        };
      },
    },
  });
  const message: IncomingChannelMessage = {
    event: {
      sourceMessageId: "om_image",
      receivedAt: "2026-09-02T12:00:00.000Z",
      userId: "ou_owner",
      rawText: JSON.stringify({ image_key: "img_v3_abc" }),
      rawPayload: { message_id: "om_image" },
    },
    chatType: "p2p",
    messageType: "image",
    senderType: "user",
  };

  assert.deepEqual(await loader.load([message]), [
    {
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    },
  ]);
  assert.equal(calls[0]?.command, "lark-cli");
  assert.deepEqual(calls[0]?.args.slice(0, 8), [
    "im",
    "+messages-resources-download",
    "--message-id",
    "om_image",
    "--file-key",
    "img_v3_abc",
    "--type",
    "image",
  ]);
  assert.deepEqual(calls[0]?.args.slice(-3), ["--as", "bot", "--json"]);
  await assert.rejects(access(dirname(savedPath)));
});

test("non-image messages do not invoke lark-cli", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-unused-image-test-"));
  let calls = 0;
  const loader = createLarkMessageImageLoader({
    runner: {
      run: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    },
  });
  try {
    assert.deepEqual(
      await loader.load([
        {
          event: {
            sourceMessageId: "om_text",
            receivedAt: "2026-09-02T12:00:00.000Z",
            userId: "ou_owner",
            rawText: "普通文字",
            rawPayload: {},
          },
          chatType: "p2p",
          messageType: "text",
          senderType: "user",
        },
      ]),
      [],
    );
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
