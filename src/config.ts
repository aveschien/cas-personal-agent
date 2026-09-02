export interface DevelopmentConfig {
  readonly databasePath: string;
  readonly allowedUserIds: readonly string[];
}

export function loadDevelopmentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentConfig {
  const databasePath = environment.CAS_DATABASE_PATH?.trim();
  if (!databasePath) {
    throw new Error("CAS_DATABASE_PATH is required");
  }

  const allowedUserIds = (environment.CAS_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (allowedUserIds.length === 0) {
    throw new Error("CAS_ALLOWED_USER_IDS must contain at least one user id");
  }

  return {
    databasePath,
    allowedUserIds,
  };
}
