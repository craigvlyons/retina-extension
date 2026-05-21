import { createServer, type Server, type Socket } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  NATIVE_HOST_VERSION,
  SOCKET_DIR_PREFIX,
  STATUS_FILE_NAME
} from "../shared/constants";
import { encodeNativeMessage, readNativeMessageFrame } from "../shared/framing";
import { BridgeLogger } from "../shared/logger";
import { normalizeToolRequest } from "../shared/protocol";

type ClientState = {
  id: number;
  socket: Socket;
  buffer: Buffer<ArrayBufferLike>;
};

const logger = new BridgeLogger("retina-native-host");
const clients = new Map<number, ClientState>();
const pendingRequestClients = new Map<string, number>();
let nextClientId = 1;
let stdinBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let server: Server | null = null;
const socketPath = process.env.RETINA_BROWSER_BRIDGE_SOCKET || defaultSocketPath();

void main().catch((error: unknown) => {
  logger.error("Native host fatal error", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  logger.info("Initializing native host", { version: NATIVE_HOST_VERSION, socketPath });
  await startSocketServer();
  setupChromeStdio();
  await writeStatus();

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function startSocketServer(): Promise<void> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true }).catch(() => undefined);
  server = createServer((socket) => {
    const id = nextClientId++;
    const state: ClientState = { id, socket, buffer: Buffer.alloc(0) };
    clients.set(id, state);
    logger.info("Retina socket client connected", { id });
    writeClient(socket, { type: "mcp_connected", nativeHostVersion: NATIVE_HOST_VERSION, socketPath });
    writeChrome({ type: "mcp_connected", clientId: id });

    socket.on("data", (chunk) => handleClientData(state, chunk));
    socket.on("close", () => {
      clients.delete(id);
      logger.info("Retina socket client disconnected", { id });
      writeChrome({ type: "mcp_disconnected", clientId: id });
    });
    socket.on("error", (error) => logger.warn("Retina socket client error", { id, error: error.message }));
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(socketPath, () => {
      server?.off("error", reject);
      resolve();
    });
  });
  await chmodSocket();
  logger.info("Socket server listening", { socketPath });
}

function setupChromeStdio(): void {
  process.stdin.on("data", (chunk: Buffer) => {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
    while (stdinBuffer.length > 0) {
      const result = readNativeMessageFrame(stdinBuffer);
      if (result.status === "need_more") {
        stdinBuffer = result.remaining;
        break;
      }
      if (result.status === "invalid_length") {
        logger.error("Invalid message length from Chrome", { length: result.length });
        stdinBuffer = result.remaining;
        continue;
      }
      stdinBuffer = result.remaining;
      handleChromeMessage(result.message);
    }
  });
  process.stdin.on("end", () => void shutdown());
}

function handleChromeMessage(raw: string): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    writeChrome({ type: "error", error: "Invalid message format" });
    return;
  }

  if (!isObject(message)) {
    writeChrome({ type: "error", error: "Invalid message format" });
    return;
  }

  if (message.type === "extension_hello") {
    logger.info("Extension hello", { version: typeof message.version === "string" ? message.version : "unknown" });
    writeChrome({ type: "get_status" });
    return;
  }

  if (message.type === "ping") {
    writeChrome({ type: "pong", timestamp: Date.now() });
    return;
  }

  if (message.type === "get_status") {
    writeChrome({ type: "status_response", native_host_version: NATIVE_HOST_VERSION, clients: clients.size, socketPath });
    return;
  }

  if (message.type === "tool_response") {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    const clientId = requestId ? pendingRequestClients.get(requestId) : undefined;
    if (requestId) pendingRequestClients.delete(requestId);
    const payload = { ...message, compatibilityAdapter: "claude-in-chrome" };
    if (clientId && clients.has(clientId)) {
      writeClient(clients.get(clientId)!.socket, payload);
    } else {
      for (const client of clients.values()) writeClient(client.socket, payload);
    }
    return;
  }

  if (message.type === "event" || message.type === "notification") {
    for (const client of clients.values()) writeClient(client.socket, message);
    return;
  }

  logger.warn("Unknown Chrome message", { type: String(message.type) });
}

function handleClientData(state: ClientState, chunk: Buffer): void {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length > 0) {
    const result = readNativeMessageFrame(state.buffer);
    if (result.status === "need_more") {
      state.buffer = result.remaining;
      break;
    }
    if (result.status === "invalid_length") {
      logger.warn("Invalid message length from Retina client", { id: state.id, length: result.length });
      state.socket.destroy();
      return;
    }
    state.buffer = result.remaining;
    forwardClientRequest(state, result.message);
  }
}

function forwardClientRequest(state: ClientState, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Failed to parse Retina client request", { id: state.id });
    writeClient(state.socket, {
      type: "tool_response",
      requestId: "unknown",
      method: "unknown",
      isError: true,
      content: [{ type: "text", text: "Failed to parse tool request." }],
      error: { code: "invalid_json", message: "Failed to parse tool request.", retryable: false }
    });
    return;
  }

  const request = normalizeToolRequest(parsed);
  if (!request) {
    writeClient(state.socket, {
      type: "tool_response",
      requestId: "unknown",
      method: "unknown",
      isError: true,
      content: [{ type: "text", text: "Invalid tool request." }],
      error: { code: "invalid_request", message: "Invalid tool request.", retryable: false }
    });
    return;
  }

  if (request.requestId) pendingRequestClients.set(request.requestId, state.id);
  logger.info("Forwarding tool request to extension", { id: state.id, method: request.method, requestId: request.requestId || null });
  writeChrome(request);
}

function writeChrome(message: unknown): void {
  try {
    process.stdout.write(encodeNativeMessage(message));
  } catch (error) {
    logger.error("Failed to write Chrome message", { error: error instanceof Error ? error.message : String(error) });
  }
}

function writeClient(socket: Socket, message: unknown): void {
  try {
    socket.write(encodeNativeMessage(message));
  } catch (error) {
    logger.warn("Failed to write client message", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function writeStatus(): Promise<void> {
  const dir = path.join(homedir(), ".retina", "browser-bridge");
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await writeFile(
    path.join(dir, STATUS_FILE_NAME),
    JSON.stringify({ pid: process.pid, socketPath, version: NATIVE_HOST_VERSION, startedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  ).catch((error) => logger.warn("Failed to write status file", { error: error.message }));
}

async function chmodSocket(): Promise<void> {
  await import("node:fs/promises")
    .then((fs) => fs.chmod(socketPath, 0o600))
    .catch(() => undefined);
}

async function shutdown(): Promise<void> {
  logger.info("Shutting down native host", { clients: clients.size });
  for (const client of clients.values()) client.socket.destroy();
  clients.clear();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  await rm(socketPath, { force: true }).catch(() => undefined);
  process.exit(0);
}

function defaultSocketPath(): string {
  const username = safeUsername();
  return path.join(tmpdir(), `${SOCKET_DIR_PREFIX}-${username}`, `${process.pid}.sock`);
}

function safeUsername(): string {
  try {
    return userInfo().username.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
  } catch {
    return "default";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
