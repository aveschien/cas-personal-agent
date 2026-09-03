import type { DevelopmentAgent } from "./development-agent.js";
import type {
  IncomingChannelMessage,
  LarkEventChannel,
} from "./lark-event-channel.js";
import type { ReplyAdapter } from "./lark-reply-adapter.js";
import type { MessageBatcher } from "./message-batcher.js";

export interface Supervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SupervisorOptions {
  readonly channel: LarkEventChannel;
  readonly agent: Pick<DevelopmentAgent, "ingest">;
  readonly replies: ReplyAdapter;
  readonly batcher?: MessageBatcher;
  readonly onError?: (error: unknown) => void;
}

function replyIdempotencyKey(messageId: string): string {
  return `reply-${messageId}`.slice(0, 50);
}

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const handleMessage = async (
    message: IncomingChannelMessage,
  ): Promise<void> => {
    if (message.chatType !== "p2p" || message.senderType !== "user") {
      return;
    }

    if (options.batcher !== undefined) {
      await options.batcher.accept(message);
      return;
    }

    const idempotencyKey = replyIdempotencyKey(
      message.event.sourceMessageId,
    );
    try {
      const result = await options.agent.ingest(message.event);
      await options.replies.reply({
        messageId: message.event.sourceMessageId,
        text: result.acknowledgement,
        idempotencyKey,
      });
    } catch (error) {
      options.onError?.(error);
      try {
        await options.replies.reply({
          messageId: message.event.sourceMessageId,
          text: "消息已收到，但这次处理没有完成。请稍后重试。",
          idempotencyKey,
        });
      } catch (replyError) {
        options.onError?.(replyError);
      }
    }
  };

  return {
    async start() {
      await options.channel.start(handleMessage);
    },

    async stop() {
      await options.channel.stop();
      await options.batcher?.stop();
    },
  };
}
