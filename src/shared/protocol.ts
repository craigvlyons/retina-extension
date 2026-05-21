import {
  COMPATIBILITY_SERVER_NAME,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RETINA_BROWSER_BRIDGE_KIND,
  SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL
} from "./constants";
import type { BridgeError, JsonObject, RuntimeEnvelope, ToolRequest, ToolResponse } from "./types";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requestId(request: ToolRequest): string {
  return request.requestId || cryptoRandomId("req");
}

export function cryptoRandomId(prefix = "id"): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeToolRequest(input: unknown): ToolRequest | null {
  if (!isObject(input)) return null;
  const method = input.method;
  if (typeof method !== "string") return null;
  const params = isObject(input.params) ? (input.params as JsonObject) : {};
  return {
    type: input.type === "tool_request" ? "tool_request" : "tool_request",
    method,
    params,
    requestId: typeof input.requestId === "string" ? input.requestId : undefined,
    compatibilityServerName:
      typeof input.compatibilityServerName === "string"
        ? input.compatibilityServerName
        : COMPATIBILITY_SERVER_NAME,
    bridgeKind:
      typeof input.bridgeKind === "string" ? input.bridgeKind : RETINA_BROWSER_BRIDGE_KIND,
    protocol:
      typeof input.protocol === "string"
        ? input.protocol
        : SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL
  };
}

export function toRuntimeEnvelope(request: ToolRequest, extras: Partial<RuntimeEnvelope> = {}): RuntimeEnvelope {
  const id = requestId(request);
  return {
    v: 1,
    id: cryptoRandomId("env"),
    type: "tool_request",
    source: "native-host",
    requestId: id,
    method: request.method,
    params: request.params || {},
    compatibility: {
      serverName: request.compatibilityServerName || COMPATIBILITY_SERVER_NAME,
      bridgeKind: request.bridgeKind || RETINA_BROWSER_BRIDGE_KIND,
      protocol: request.protocol || SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL
    },
    meta: { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    ...extras
  };
}

export function okResponse(
  request: Pick<ToolRequest, "method"> & { requestId?: string },
  structuredContent: JsonObject = {},
  text = "OK",
  meta: JsonObject = {}
): ToolResponse {
  return {
    v: 1,
    id: cryptoRandomId("res"),
    type: "tool_response",
    requestId: request.requestId || cryptoRandomId("req"),
    method: request.method,
    status: "ok",
    isError: false,
    content: [{ type: "text", text }],
    structuredContent,
    error: null,
    meta
  };
}

export function errorResponse(
  request: Pick<ToolRequest, "method"> & { requestId?: string },
  status: ToolResponse["status"],
  code: string,
  message: string,
  details: JsonObject = {},
  retryable = false
): ToolResponse {
  const error: BridgeError = { code, message, retryable, details };
  return {
    v: 1,
    id: cryptoRandomId("res"),
    type: "tool_response",
    requestId: request.requestId || cryptoRandomId("req"),
    method: request.method,
    status,
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {},
    error,
    meta: { durationMs: 0 }
  };
}

export function enforcePayloadLimit<T extends ToolResponse>(response: T, maxBytes: number): T {
  const encoded = new TextEncoder().encode(JSON.stringify(response));
  if (encoded.byteLength <= maxBytes) return response;
  return {
    ...response,
    structuredContent: {
      truncated: true,
      originalBytes: encoded.byteLength,
      message: "Response exceeded native messaging payload limit."
    },
    content: [{ type: "text", text: "Response truncated because it exceeded the bridge payload limit." }]
  };
}

