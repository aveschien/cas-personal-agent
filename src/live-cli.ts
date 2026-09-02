import { pathToFileURL } from "node:url";

import {
  loadLiveConfig,
  type LiveEnvironment,
} from "./live-config.js";
import {
  createLiveService,
  type LiveService,
  type LiveServiceConfig,
} from "./live-service.js";

export interface RunLiveCliOptions {
  readonly cwd: string;
  readonly environment: LiveEnvironment;
  readonly waitForShutdown: Promise<void>;
  readonly serviceFactory?: (
    config: LiveServiceConfig,
  ) => Promise<LiveService>;
  readonly log?: (message: string) => void;
}

export async function runLiveCli(options: RunLiveCliOptions): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message));
  const config = loadLiveConfig(options.environment, options.cwd);
  const service = await (options.serviceFactory ?? createLiveService)(config);
  try {
    await service.start();
    log("[cas] ready channel=lark runtime=pi");
    await Promise.race([
      options.waitForShutdown,
      service.waitForExit(),
    ]);
  } finally {
    await service.stop();
    log("[cas] stopped");
  }
}

function waitForProcessShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
}

async function main(): Promise<void> {
  await runLiveCli({
    cwd: process.cwd(),
    environment: process.env,
    waitForShutdown: waitForProcessShutdown(),
  });
}

const executable = process.argv[1];
if (
  executable !== undefined &&
  pathToFileURL(executable).href === import.meta.url
) {
  main().catch((error: unknown) => {
    console.error(
      `[cas] fatal ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
