const SECRET_KEYS = [
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /token/i,
  /secret/i,
  /password/i,
  /api[-_]?key/i,
  /session/i
];

const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
  /(sk-[A-Za-z0-9_-]{20,})/g,
  /([A-Za-z0-9+/]{24,}={0,2})/g
];

export function redactText(input: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[REDACTED]"),
    input
  );
}

export function redactValue<T>(value: T, keyHint = ""): T {
  if (SECRET_KEYS.some((pattern) => pattern.test(keyHint))) {
    return "[REDACTED]" as T;
  }
  if (typeof value === "string") {
    return redactText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactValue(child, key);
    }
    return out as T;
  }
  return value;
}

