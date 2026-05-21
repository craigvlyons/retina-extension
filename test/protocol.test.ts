import { describe, expect, it } from "vitest";
import {
  COMPATIBILITY_SERVER_NAME,
  RETINA_BROWSER_BRIDGE_KIND,
  SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL
} from "../src/shared/constants";
import { normalizeToolRequest, toRuntimeEnvelope, errorResponse } from "../src/shared/protocol";

describe("protocol", () => {
  it("normalizes source-compatible tool requests", () => {
    const request = normalizeToolRequest({
      method: "computer",
      params: { action: "left_click" },
      requestId: "r1"
    });

    expect(request).toEqual({
      type: "tool_request",
      method: "computer",
      params: { action: "left_click" },
      requestId: "r1",
      compatibilityServerName: COMPATIBILITY_SERVER_NAME,
      bridgeKind: RETINA_BROWSER_BRIDGE_KIND,
      protocol: SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL
    });
  });

  it("wraps runtime envelopes without replacing source fields", () => {
    const envelope = toRuntimeEnvelope({
      type: "tool_request",
      method: "read_page",
      params: {},
      requestId: "r2"
    });

    expect(envelope.method).toBe("read_page");
    expect(envelope.requestId).toBe("r2");
    expect(envelope.compatibility).toEqual({
      serverName: COMPATIBILITY_SERVER_NAME,
      bridgeKind: RETINA_BROWSER_BRIDGE_KIND,
      protocol: SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL
    });
  });

  it("creates source-shaped error responses", () => {
    const response = errorResponse(
      { method: "computer", requestId: "r3" },
      "stale_candidate",
      "candidate_mismatch",
      "Candidate moved.",
      { candidateId: "browser:1:0:dom:abc" },
      true
    );

    expect(response.type).toBe("tool_response");
    expect(response.isError).toBe(true);
    expect(response.status).toBe("stale_candidate");
    expect(response.error?.retryable).toBe(true);
  });
});

