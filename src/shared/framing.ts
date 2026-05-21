import { MAX_CHROME_TO_NATIVE_HOST_BYTES, MAX_NATIVE_HOST_TO_CHROME_BYTES } from "./constants";

export type FrameReadResult =
  | { status: "need_more"; remaining: Buffer }
  | { status: "complete"; message: string; remaining: Buffer }
  | { status: "invalid_length"; length: number; remaining: Buffer };

export function encodeNativeMessage(value: unknown, maxBytes = MAX_NATIVE_HOST_TO_CHROME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > maxBytes) {
    throw new Error(`Native message length ${body.length} is outside allowed range`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function readNativeMessageFrame(
  buffer: Buffer,
  maxBytes = MAX_CHROME_TO_NATIVE_HOST_BYTES
): FrameReadResult {
  if (buffer.length < 4) {
    return { status: "need_more", remaining: buffer };
  }
  const length = buffer.readUInt32LE(0);
  if (length === 0 || length > maxBytes) {
    return { status: "invalid_length", length, remaining: buffer.subarray(4) };
  }
  if (buffer.length < 4 + length) {
    return { status: "need_more", remaining: buffer };
  }
  const message = buffer.subarray(4, 4 + length).toString("utf8");
  return { status: "complete", message, remaining: buffer.subarray(4 + length) };
}

