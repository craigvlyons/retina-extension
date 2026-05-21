import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

const method = process.argv[2] || "tabs_context_mcp";
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const statusPath = path.join(homedir(), ".retina", "browser-bridge", "status.json");

const status = await readStatus();
const socketPath = status.socketPath;
if (!socketPath) {
  throw new Error(`No socketPath in ${statusPath}`);
}

const request = {
  type: "tool_request",
  method,
  params,
  requestId: `smoke-${Date.now()}`,
  compatibilityServerName: "claude-in-chrome",
  bridgeKind: "retina-browser-bridge",
  protocol: "source_chrome_mcp_compatibility"
};

const socket = connect(socketPath);
let buffer = Buffer.alloc(0);
let sent = false;
const timer = setTimeout(() => {
  console.error("Timed out waiting for bridge response.");
  socket.destroy();
  process.exit(1);
}, 15_000);

socket.on("connect", () => {
  sent = true;
  socket.write(encode(request));
});

socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) return;
    const raw = buffer.subarray(4, 4 + length).toString("utf8");
    buffer = buffer.subarray(4 + length);
    const message = JSON.parse(raw);
    if (message.type === "mcp_connected") {
      continue;
    }
    if (message.requestId && message.requestId !== request.requestId) {
      console.error(`Ignoring response for ${message.requestId}; waiting for ${request.requestId}.`);
      continue;
    }
    clearTimeout(timer);
    console.log(JSON.stringify(message, null, 2));
    socket.end();
    return;
  }
});

socket.on("error", (error) => {
  clearTimeout(timer);
  console.error(`Failed to connect to ${socketPath}: ${error.message}`);
  if (!sent) {
    console.error("Open the extension popup or click Reload on chrome://extensions, then run this again.");
  }
  process.exit(1);
});

async function readStatus() {
  try {
    return JSON.parse(await readFile(statusPath, "utf8"));
  } catch (error) {
    console.error(`Could not read ${statusPath}.`);
    console.error("Open the Retina Browser Bridge popup or click Reload on chrome://extensions first.");
    throw error;
  }
}

function encode(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
