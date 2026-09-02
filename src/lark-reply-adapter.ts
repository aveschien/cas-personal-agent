import { spawn } from "node:child_process";

export interface ReplyRequest {
  readonly messageId: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface ReplyAdapter {
  reply(request: ReplyRequest): Promise<void>;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

export interface LarkReplyAdapterOptions {
  readonly command?: string;
  readonly runner?: CommandRunner;
}

const processRunner: CommandRunner = {
  run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  },
};

export function createLarkReplyAdapter(
  options: LarkReplyAdapterOptions = {},
): ReplyAdapter {
  const command = options.command ?? "lark-cli";
  const runner = options.runner ?? processRunner;

  return {
    async reply(request) {
      if (request.idempotencyKey.length > 50) {
        throw new Error("Lark reply idempotency key exceeds 50 characters");
      }
      const result = await runner.run(command, [
        "im",
        "+messages-reply",
        "--message-id",
        request.messageId,
        "--markdown",
        request.text,
        "--idempotency-key",
        request.idempotencyKey,
        "--as",
        "bot",
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `lark-cli reply failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }
    },
  };
}
