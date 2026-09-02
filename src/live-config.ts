import { resolve } from "node:path";

import type { LiveServiceConfig } from "./live-service.js";

export interface LiveEnvironment {
  readonly [key: string]: string | undefined;
  readonly CAS_ALLOWED_USER_IDS?: string;
  readonly CAS_DATABASE_PATH?: string;
  readonly CAS_PI_SESSION_DIR?: string;
  readonly CAS_PI_MODEL?: string;
}

function parseAllowlist(value: string | undefined): string[] {
  const userIds = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0),
    ),
  ];
  if (userIds.length === 0) {
    throw new Error(
      "CAS_ALLOWED_USER_IDS must contain at least one Feishu user ID",
    );
  }
  return userIds;
}

export function loadLiveConfig(
  environment: LiveEnvironment,
  cwd: string,
): LiveServiceConfig {
  const piModel = environment.CAS_PI_MODEL ?? "openai-codex/gpt-5.6-luna";
  if (!/^[^/]+\/[^/]+$/.test(piModel)) {
    throw new Error("CAS_PI_MODEL must use provider/model format");
  }

  return {
    cwd,
    databasePath: resolve(
      cwd,
      environment.CAS_DATABASE_PATH ?? "./var/cas-agent.sqlite",
    ),
    allowedUserIds: parseAllowlist(environment.CAS_ALLOWED_USER_IDS),
    piSessionDirectory: resolve(
      cwd,
      environment.CAS_PI_SESSION_DIR ?? "./var/pi-sessions",
    ),
    piModel,
  };
}
