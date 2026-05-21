import { describe, expect, it } from "vitest";
import { encodeNativeMessage, readNativeMessageFrame } from "../src/shared/framing";

describe("native message framing", () => {
  it("encodes and reads Chrome native messaging frames", () => {
    const frame = encodeNativeMessage({ type: "ping" });
    expect(frame.subarray(0, 4)).toEqual(Buffer.from([15, 0, 0, 0]));

    const result = readNativeMessageFrame(frame);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(JSON.parse(result.message)).toEqual({ type: "ping" });
      expect(result.remaining.length).toBe(0);
    }
  });

  it("keeps partial frames buffered", () => {
    const frame = encodeNativeMessage({ type: "get_status" });
    const result = readNativeMessageFrame(frame.subarray(0, 6));
    expect(result.status).toBe("need_more");
  });

  it("rejects zero-length frames", () => {
    const result = readNativeMessageFrame(Buffer.from([0, 0, 0, 0]));
    expect(result.status).toBe("invalid_length");
  });
});

