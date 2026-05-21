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

if (params.urlIncludes && !params.tabId) {
  const tabs = await callBridge("tabs_context_mcp", {});
  const needle = String(params.urlIncludes);
  const tab = tabs.structuredContent?.tabs?.find((item) => item.url?.includes(needle));
  if (!tab) {
    console.error(`No tab URL includes ${needle}`);
    console.error(JSON.stringify(tabs.structuredContent?.tabs || [], null, 2));
    process.exit(1);
  }
  params.tabId = tab.tabId;
  delete params.urlIncludes;
}

if (params.titleIncludes && !params.tabId) {
  const tabs = await callBridge("tabs_context_mcp", {});
  const needle = String(params.titleIncludes).toLowerCase();
  const tab = tabs.structuredContent?.tabs?.find((item) => item.title?.toLowerCase().includes(needle));
  if (!tab) {
    console.error(`No tab title includes ${needle}`);
    console.error(JSON.stringify(tabs.structuredContent?.tabs || [], null, 2));
    process.exit(1);
  }
  params.tabId = tab.tabId;
  delete params.titleIncludes;
}

const message = await callBridge(method, params);
console.log(JSON.stringify(message, null, 2));

async function callBridge(methodName, requestParams) {
  const request = {
  type: "tool_request",
  method: methodName,
  params: requestParams,
  requestId: `smoke-${Date.now()}`,
  compatibilityServerName: "claude-in-chrome",
  bridgeKind: "retina-browser-bridge",
  protocol: "source_chrome_mcp_compatibility"
  };

  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    let sent = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for bridge response."));
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
        const response = JSON.parse(raw);
        if (response.type === "mcp_connected") continue;
        if (response.requestId && response.requestId !== request.requestId) continue;
        clearTimeout(timer);
        socket.end();
        resolve(response);
        return;
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      if (!sent) {
        error.message += " Open the Retina Browser Bridge popup or click Reload on chrome://extensions, then run this again.";
      }
      reject(error);
    });
  });
}

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
