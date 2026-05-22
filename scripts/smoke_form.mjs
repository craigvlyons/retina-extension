import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

const statusPath = path.join(homedir(), ".retina", "browser-bridge", "status.json");
const fixturePath = path.join(process.cwd(), "test", "fixtures", "form-smoke.html");
const fixture = await readFile(fixturePath, "utf8");
const status = await readStatus();
const socketPath = status.socketPath;
if (!socketPath) throw new Error(`No socketPath in ${statusPath}`);
const sessionId = `smoke-form-${Date.now()}`;

const server = createServer((request, response) => {
  if (request.url?.startsWith("/done.html")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Done</title><h1>Navigation settled</h1><p>The click reached the destination page.</p>");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fixture);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  await callBridge("tabs_create_mcp", { url: `${baseUrl}/form.html`, active: true, sessionId });
  const tab = await waitForTab((item) => item.ownedBySessionId === sessionId || item.url?.startsWith(baseUrl));
  const tabId = tab.tabId;

  await waitForText(tabId, "Retina Form Smoke");
  await callBridge("computer", { tabId, action: "left_click", ref: "#search", settle: false });
  await callBridge("computer", { tabId, action: "type", ref: "#search", text: "retina smoke", settle: false });
  await callBridge("computer", { tabId, action: "key", key: "Enter" });
  await waitForText(tabId, "Submitted: retina smoke");
  await callBridge("computer", { tabId, action: "left_click", ref: "#nav-link" });
  await waitForText(tabId, "Navigation settled");

  console.log(JSON.stringify({ ok: true, tabId, url: `${baseUrl}/done.html` }, null, 2));
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function waitForTab(predicate) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const tabs = await callBridge("tabs_context_mcp", {});
    const tab = tabs.structuredContent?.tabs?.find(predicate);
    if (tab) return tab;
    await delay(200);
  }
  throw new Error("Timed out waiting for smoke tab.");
}

async function waitForText(tabId, expected) {
  const started = Date.now();
  let lastText = "";
  while (Date.now() - started < 10_000) {
    const response = await callBridge("get_page_text", { tabId }).catch((error) => ({ error }));
    lastText = response.structuredContent?.text || "";
    if (lastText.includes(expected)) return response;
    await delay(250);
  }
  throw new Error(`Timed out waiting for page text ${JSON.stringify(expected)}. Last text: ${lastText.slice(0, 500)}`);
}

async function callBridge(methodName, requestParams) {
  const request = {
    type: "tool_request",
    method: methodName,
    params: requestParams,
    requestId: `smoke-form-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    compatibilityServerName: "claude-in-chrome",
    bridgeKind: "retina-browser-bridge",
    protocol: "source_chrome_mcp_compatibility"
  };

  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for ${methodName}.`));
    }, 20_000);

    socket.on("connect", () => {
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
        if (response.isError) {
          reject(new Error(`${methodName} failed: ${response.error?.message || response.content?.[0]?.text || "unknown error"}`));
        } else {
          resolve(response);
        }
        return;
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
