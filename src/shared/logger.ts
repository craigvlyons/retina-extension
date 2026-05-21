import { redactValue } from "./redaction";
import type { JsonObject, ObservationEvent } from "./types";

export type LogSink = (line: string) => void;

export class BridgeLogger {
  constructor(
    private readonly name: string,
    private readonly sink: LogSink = (line) => console.error(line),
    private readonly redact = true
  ) {}

  debug(message: string, data: JsonObject = {}): void {
    this.write("debug", message, data);
  }

  info(message: string, data: JsonObject = {}): void {
    this.write("info", message, data);
  }

  warn(message: string, data: JsonObject = {}): void {
    this.write("warn", message, data);
  }

  error(message: string, data: JsonObject = {}): void {
    this.write("error", message, data);
  }

  observation(event: ObservationEvent): void {
    this.write(event.severity, event.message, { category: event.category, ...(event.data || {}) });
  }

  private write(level: string, message: string, data: JsonObject): void {
    const payload = this.redact ? redactValue(data) : data;
    this.sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        name: this.name,
        level,
        message,
        data: payload
      })
    );
  }
}

