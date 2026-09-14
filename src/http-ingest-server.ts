import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  ChannelEvent,
  IngestResult,
} from "./development-agent.js";
import { IngestBusyError } from "./serial-queue.js";

const maxBodyBytes = 1_048_576;
const ingestPath = "/v1/ingest";
export const grokSourceMessageIdPrefix = "grok:";
export const grokSourceMessageIdAltPrefix = "grok-";

export function canonicalizeGrokSourceMessageId(id: string): string {
  const trimmed = id.trim();
  if (
    trimmed.startsWith(grokSourceMessageIdPrefix) ||
    trimmed.startsWith(grokSourceMessageIdAltPrefix)
  ) {
    return trimmed;
  }
  return `${grokSourceMessageIdPrefix}${trimmed}`;
}

export interface HttpIngestServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  url(): string | undefined;
}

export interface HttpIngestServerOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly ingest: (event: ChannelEvent) => Promise<IngestResult>;
  readonly clock?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) {
    return false;
  }
  const match = /^Bearer[ \t]+(\S+)/i.exec(header.trim());
  if (match === null) {
    return false;
  }
  const provided = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function requestPath(url: string | undefined): string {
  const path = (url ?? "/").split("?")[0] ?? "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("request body exceeds 1MB");
    this.name = "PayloadTooLargeError";
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseIngestRequest(
  value: unknown,
  clock: () => string,
): ChannelEvent {
  if (!isRecord(value)) {
    throw new Error("request body must be a JSON object");
  }
  if (typeof value.sourceMessageId !== "string" || value.sourceMessageId.trim().length === 0) {
    throw new Error("sourceMessageId must be a non-empty string");
  }
  if (typeof value.userId !== "string" || value.userId.trim().length === 0) {
    throw new Error("userId must be a non-empty string");
  }
  if (typeof value.rawText !== "string") {
    throw new Error("rawText must be a string");
  }
  const receivedAt =
    value.receivedAt === undefined || value.receivedAt === ""
      ? clock()
      : value.receivedAt;
  if (typeof receivedAt !== "string" || Number.isNaN(Date.parse(receivedAt))) {
    throw new Error("receivedAt must be an ISO-8601 timestamp");
  }
  const rawPayload = value.rawPayload === undefined ? {} : value.rawPayload;
  if (!isRecord(rawPayload)) {
    throw new Error("rawPayload must be a JSON object");
  }

  return {
    sourceMessageId: canonicalizeGrokSourceMessageId(value.sourceMessageId),
    receivedAt,
    userId: value.userId,
    rawText: value.rawText,
    rawPayload: {
      ...rawPayload,
      channel: "grok",
    },
    source: "grok",
  };
}

function listenUrl(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP ingest server has no TCP address");
  }
  const host =
    address.address === "::" || address.address === "::1"
      ? "127.0.0.1"
      : address.address.includes(":")
        ? `[${address.address}]`
        : address.address;
  return `http://${host}:${String(address.port)}`;
}

export function createHttpIngestServer(
  options: HttpIngestServerOptions,
): HttpIngestServer {
  if (options.token.trim().length === 0) {
    throw new Error("HTTP ingest token must not be empty");
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  let server: Server | undefined;
  let startedUrl: string | undefined;

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const path = requestPath(request.url);
    if (path !== ingestPath) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (!bearerMatches(request.headers.authorization, options.token)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readBody(request);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        writeJson(response, 413, { error: "payload_too_large" });
        request.destroy();
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = bodyText.trim().length === 0 ? {} : (JSON.parse(bodyText) as unknown);
    } catch {
      writeJson(response, 400, {
        error: "invalid_request",
        message: "request body must be valid JSON",
      });
      return;
    }

    let event: ChannelEvent;
    try {
      event = parseIngestRequest(parsed, clock);
    } catch (error) {
      writeJson(response, 400, {
        error: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      const result = await options.ingest(event);
      writeJson(response, result.status === "rejected" ? 403 : 200, result);
    } catch (error) {
      if (error instanceof IngestBusyError) {
        writeJson(response, 503, {
          error: "ingest_busy",
          message: error.message,
        });
        return;
      }
      writeJson(response, 500, {
        status: "failed",
        acknowledgement: "消息已收到，但这次处理没有完成。请稍后重试。",
      });
    }
  };

  return {
    async start() {
      if (server !== undefined) {
        return;
      }
      const next = createServer((request, response) => {
        void handle(request, response).catch(() => {
          if (!response.headersSent) {
            writeJson(response, 500, {
              status: "failed",
              acknowledgement: "消息已收到，但这次处理没有完成。请稍后重试。",
            });
          } else {
            response.destroy();
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          next.close();
          reject(error);
        };
        next.once("error", onError);
        next.listen(options.port, options.host, () => {
          next.off("error", onError);
          resolve();
        });
      });
      server = next;
      startedUrl = listenUrl(next);
    },

    async stop() {
      const current = server;
      if (current === undefined) {
        return;
      }
      server = undefined;
      startedUrl = undefined;
      current.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        current.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },

    url() {
      return startedUrl;
    },
  };
}
