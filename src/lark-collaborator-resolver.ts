import type {
  CollaboratorCandidate,
  CollaboratorResolver,
} from "./collaborator.js";
import {
  processCommandRunner,
  type CommandRunner,
} from "./lark-reply-adapter.js";

export interface LarkCollaboratorResolverOptions {
  readonly command?: string;
  readonly runner?: CommandRunner;
}

interface LarkEnvelope {
  readonly ok?: unknown;
  readonly data?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCandidates(stdout: string): readonly CollaboratorCandidate[] {
  const envelope = record(JSON.parse(stdout) as LarkEnvelope);
  const data = record(envelope?.data);
  if (envelope?.ok !== true || !Array.isArray(data?.users)) {
    throw new Error("lark-cli returned an invalid collaborator search result");
  }
  return data.users.map((value) => {
    const user = record(value);
    if (
      typeof user?.open_id !== "string" ||
      typeof user.localized_name !== "string" ||
      typeof user.is_cross_tenant !== "boolean"
    ) {
      throw new Error("lark-cli returned an invalid collaborator candidate");
    }
    return {
      openId: user.open_id,
      name: user.localized_name,
      ...(typeof user.department === "string" && user.department.length > 0
        ? { department: user.department }
        : {}),
      ...(typeof user.enterprise_email === "string" &&
      user.enterprise_email.length > 0
        ? { enterpriseEmail: user.enterprise_email }
        : {}),
      isCrossTenant: user.is_cross_tenant,
    };
  });
}

export function createLarkCollaboratorResolver(
  options: LarkCollaboratorResolverOptions = {},
): CollaboratorResolver {
  const command = options.command ?? "lark-cli";
  const runner = options.runner ?? processCommandRunner;
  return {
    async resolve(query) {
      const normalized = query.trim();
      if (normalized.length === 0 || [...normalized].length > 50) {
        throw new Error("Collaborator query must contain 1 to 50 characters");
      }
      const result = await runner.run(command, [
        "contact",
        "+search-user",
        "--query",
        normalized,
        "--page-size",
        "10",
        "--as",
        "user",
        "--json",
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `lark-cli collaborator lookup failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }
      return parseCandidates(result.stdout);
    },
  };
}
