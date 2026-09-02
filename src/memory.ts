import { createHash } from "node:crypto";

import {
  createClient,
  createConfig,
  HindsightClient,
  HindsightError,
  sdk,
  type RecallResult,
} from "@vectorize-io/hindsight-client";

export type MemoryCategory =
  | "correction"
  | "preference"
  | "boundary"
  | "decision"
  | "project_change"
  | "outcome"
  | "handoff";

export interface MemoryCandidate {
  readonly key: string;
  readonly category: MemoryCategory;
  readonly content: string;
}

export interface RecalledMemory {
  readonly id: string;
  readonly text: string;
  readonly type: string;
  readonly source: {
    readonly system: "hindsight";
    readonly documentId: string | null;
    readonly sourceEventId: string | null;
    readonly mentionedAt: string | null;
  };
}

export interface MemoryRecallRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
}

export interface MemoryRetainRequest {
  readonly candidate: MemoryCandidate;
  readonly sourceEventId: string;
  readonly occurredAt: string;
  readonly operationId: string;
  readonly signal: AbortSignal;
}

export interface MemoryAdapter {
  recall(request: MemoryRecallRequest): Promise<readonly RecalledMemory[]>;
  retain(request: MemoryRetainRequest): Promise<void>;
}

export interface HindsightClientBoundary {
  recall(
    bankId: string,
    query: string,
    options: {
      readonly budget: "low";
      readonly maxTokens: number;
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly results: readonly RecallResult[] }>;
  retain(
    bankId: string,
    content: string,
    options: {
      readonly timestamp: string;
      readonly context: string;
      readonly metadata: Record<string, string>;
      readonly documentId: string;
      readonly async: true;
      readonly operationId: string;
      readonly tags: string[];
      readonly observationScopes: "shared";
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly success: boolean }>;
  getOperationStatus(
    bankId: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly status: string;
    readonly errorMessage: string | null;
  }>;
}

export interface HindsightMemoryAdapterOptions {
  readonly baseUrl: string;
  readonly bankId: string;
  readonly client?: HindsightClientBoundary;
}

const stableKeyPattern = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+/i,
  /\b(?:sk|hsk)-[A-Za-z0-9_-]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/i,
] as const;

export function validateMemoryCandidate(candidate: MemoryCandidate): void {
  if (!stableKeyPattern.test(candidate.key)) {
    throw new Error("memory candidate key must be a stable lowercase key");
  }
  const content = candidate.content.trim();
  if (content.length === 0 || content.length > 1_000) {
    throw new Error("memory candidate content must contain 1 to 1000 characters");
  }
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    throw new Error("memory candidate contains secret-like material");
  }
}

export function memoryOperationId(
  sourceEventId: string,
  candidateKey: string,
): string {
  const bytes = createHash("sha256")
    .update(`cas-memory:${sourceEventId}:${candidateKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceEventId(result: RecallResult): string | null {
  const value = result.metadata?.source_event_id;
  return typeof value === "string" ? value : null;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Hindsight operation polling aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultClient(options: HindsightMemoryAdapterOptions): HindsightClientBoundary {
  const userAgent = "cas-personal-agent/0.1.0";
  const client = new HindsightClient({
    baseUrl: options.baseUrl,
    userAgent,
  });
  const generatedClient = createClient(
    createConfig({
      baseUrl: options.baseUrl,
      headers: { "User-Agent": userAgent },
    }),
  );
  return {
    recall: (bankId, query, recallOptions) =>
      client.recall(bankId, query, recallOptions),
    retain: (bankId, content, retainOptions) =>
      client.retain(bankId, content, retainOptions),
    async getOperationStatus(bankId, operationId, signal) {
      const response = await sdk.getOperationStatus({
        client: generatedClient,
        path: { bank_id: bankId, operation_id: operationId },
        signal,
      });
      if (response.data === undefined) {
        throw new HindsightError(
          "getOperationStatus failed",
          response.response?.status,
          response.error,
        );
      }
      return {
        status: response.data.status,
        errorMessage: response.data.error_message ?? null,
      };
    },
  };
}

export function createHindsightMemoryAdapter(
  options: HindsightMemoryAdapterOptions,
): MemoryAdapter {
  const client =
    options.client ??
    defaultClient(options);

  return {
    async recall(request) {
      const response = await client.recall(options.bankId, request.query, {
        budget: "low",
        maxTokens: request.maxTokens,
        signal: request.signal,
      });
      return response.results.slice(0, request.maxResults).map((result) => ({
        id: result.id,
        text: result.text,
        type: result.type ?? "unknown",
        source: {
          system: "hindsight",
          documentId: result.document_id ?? null,
          sourceEventId: sourceEventId(result),
          mentionedAt: result.mentioned_at ?? null,
        },
      }));
    },

    async retain(request) {
      validateMemoryCandidate(request.candidate);
      const response = await client.retain(
        options.bankId,
        request.candidate.content.trim(),
        {
          timestamp: request.occurredAt,
          context: `cas:${request.candidate.category}`,
          metadata: {
            source: "feishu",
            source_event_id: request.sourceEventId,
            category: request.candidate.category,
            candidate_key: request.candidate.key,
          },
          documentId: `cas:${request.sourceEventId}:${request.candidate.key}`,
          async: true,
          operationId: request.operationId,
          tags: [`category:${request.candidate.category}`],
          observationScopes: "shared",
          signal: request.signal,
        },
      );
      if (!response.success) {
        throw new Error("Hindsight retain was not accepted");
      }
      for (;;) {
        const operation = await client.getOperationStatus(
          options.bankId,
          request.operationId,
          request.signal,
        );
        if (operation.status === "completed") {
          return;
        }
        if (["failed", "cancelled"].includes(operation.status)) {
          throw new Error(
            `Hindsight retain ${operation.status}: ${operation.errorMessage ?? "unknown error"}`,
          );
        }
        await wait(500, request.signal);
      }
    },
  };
}
