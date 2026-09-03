import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { IncomingChannelMessage } from "./lark-event-channel.js";
import {
  processCommandRunner,
  type CommandRunner,
} from "./lark-reply-adapter.js";
import type { PromptImage } from "./prompt-image.js";

export interface MessageImageLoader {
  load(
    messages: readonly IncomingChannelMessage[],
  ): Promise<readonly PromptImage[]>;
}

export interface LarkMessageImageLoaderOptions {
  readonly command?: string;
  readonly runner?: CommandRunner;
  readonly maxImages?: number;
  readonly maxImageBytes?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function imageKey(message: IncomingChannelMessage): string | undefined {
  if (message.messageType !== "image") {
    return undefined;
  }
  try {
    const content = record(JSON.parse(message.event.rawText) as unknown);
    return typeof content?.image_key === "string"
      ? content.image_key
      : undefined;
  } catch {
    return undefined;
  }
}

function mimeType(data: Uint8Array): string {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(
      String.fromCharCode(...data.subarray(0, 6)),
    )
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new Error("Downloaded Feishu resource is not a supported image");
}

function savedPath(stdout: string, directory: string): string {
  const envelope = record(JSON.parse(stdout) as unknown);
  const data = record(envelope?.data);
  if (envelope?.ok !== true || typeof data?.saved_path !== "string") {
    throw new Error("lark-cli returned an invalid image download result");
  }
  const path = resolve(data.saved_path);
  const root = `${resolve(directory)}/`;
  if (!path.startsWith(root)) {
    throw new Error("lark-cli saved an image outside the temporary directory");
  }
  return path;
}

export function createLarkMessageImageLoader(
  options: LarkMessageImageLoaderOptions = {},
): MessageImageLoader {
  const command = options.command ?? "lark-cli";
  const runner = options.runner ?? processCommandRunner;
  const maxImages = options.maxImages ?? 5;
  const maxImageBytes = options.maxImageBytes ?? 10 * 1024 * 1024;
  return {
    async load(messages) {
      const targets = messages.flatMap((message) => {
        const key = imageKey(message);
        return key === undefined ? [] : [{ message, key }];
      });
      if (targets.length > maxImages) {
        throw new Error(`A message batch can contain at most ${maxImages} images`);
      }
      if (targets.length === 0) {
        return [];
      }
      const directory = await mkdtemp(join(tmpdir(), "cas-lark-images-"));
      try {
        const images: PromptImage[] = [];
        for (const [index, target] of targets.entries()) {
          const output = join(directory, `image-${index + 1}`);
          const result = await runner.run(command, [
            "im",
            "+messages-resources-download",
            "--message-id",
            target.message.event.sourceMessageId,
            "--file-key",
            target.key,
            "--type",
            "image",
            "--output",
            output,
            "--as",
            "bot",
            "--json",
          ]);
          if (result.exitCode !== 0) {
            throw new Error(
              `lark-cli image download failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
            );
          }
          const bytes = await readFile(savedPath(result.stdout, directory));
          if (bytes.byteLength > maxImageBytes) {
            throw new Error(
              `A Feishu image exceeds the ${maxImageBytes} byte limit`,
            );
          }
          images.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: mimeType(bytes),
          });
        }
        return images;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
