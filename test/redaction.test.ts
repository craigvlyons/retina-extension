import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "../src/shared/redaction";

describe("redaction", () => {
  it("redacts bearer tokens in text", () => {
    expect(redactText("Authorization: Bearer abc.def.ghi")).toContain("[REDACTED]");
  });

  it("redacts secret-shaped object keys", () => {
    expect(redactValue({ headers: { cookie: "session=yes" }, ok: true })).toEqual({
      headers: { cookie: "[REDACTED]" },
      ok: true
    });
  });
});

