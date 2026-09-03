import type { CommandRunner } from "./lark-reply-adapter.js";
import type {
  ReminderDelivery,
  ReminderNotifier,
} from "./reminder-worker.js";

export interface LarkReminderNotifierOptions {
  readonly userId: string;
  readonly command?: string;
  readonly runner: CommandRunner;
}

const heading = {
  checkpoint: "检查点已到",
  deadline: "截止时间已到",
  scheduled_event: "时间安排开始",
} as const;

export function reminderMarkdown(delivery: ReminderDelivery): string {
  return [
    `**${heading[delivery.kind]}：${delivery.title}**`,
    delivery.context,
    delivery.suggestedAction ?? "请确认当前状态和下一步。",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}

export function createLarkReminderNotifier(
  options: LarkReminderNotifierOptions,
): ReminderNotifier {
  const command = options.command ?? "lark-cli";
  return {
    async notify(delivery) {
      const result = await options.runner.run(command, [
        "im",
        "+messages-send",
        "--user-id",
        options.userId,
        "--markdown",
        reminderMarkdown(delivery),
        "--idempotency-key",
        delivery.idempotencyKey,
        "--as",
        "bot",
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `lark-cli reminder failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }
    },
  };
}
