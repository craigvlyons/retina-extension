import {
  COMPATIBILITY_SERVER_NAME,
  DEFAULT_SETTINGS,
  MUTATING_TOOLS,
  NATIVE_HOST_ID,
  RETINA_BROWSER_BRIDGE_KIND,
  SITE_PERMISSION_TOOLS,
  SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL,
  VISIBLE_CONTROL_TOOLS
} from "../shared/constants";
import { BridgeLogger } from "../shared/logger";
import { enforcePayloadLimit, errorResponse, normalizeToolRequest, okResponse } from "../shared/protocol";
import { redactValue } from "../shared/redaction";
import type {
  BrowserCandidate,
  BrowserTabRecord,
  ComputerActionInput,
  ExtensionSettings,
  JsonObject,
  PopupState,
  ToolRequest,
  ToolResponse
} from "../shared/types";

type NativePort = chrome.runtime.Port;
type DebugEvent = { tabId: number; ts: number; kind: "console" | "network"; level?: string; message?: string; url?: string; method?: string; status?: number; requestId?: string; data?: JsonObject };
type NavigationSettleResult = { navigated: boolean; url?: string; status?: string; timedOut?: boolean };

const logger = new BridgeLogger("retina-extension-service-worker", (line) => console.info(line));
let nativePort: NativePort | null = null;
let nativeConnected = false;
let reconnectTimer: number | null = null;
let lastAction = "";
let lastError = "";
const sessionTabs = new Map<number, string>();
const debugEvents: DebugEvent[] = [];
const attachedDebugTabs = new Set<number>();

void connectNative();

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaultSettings();
});

chrome.runtime.onStartup.addListener(() => {
  void connectNative();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handlePopupMessage(message).then(sendResponse).catch((error: unknown) => {
    sendResponse({ ok: false, message: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

chrome.debugger?.onEvent?.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  recordDebuggerEvent(source.tabId, method, (params || {}) as JsonObject);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessionTabs.delete(tabId);
  attachedDebugTabs.delete(tabId);
});

async function connectNative(): Promise<void> {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_ID);
    nativeConnected = false;
    logger.info("Opened native host port", { host: NATIVE_HOST_ID });
    nativePort.onMessage.addListener((message) => void handleNativeMessage(message));
    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || "Native host disconnected.";
      nativeConnected = false;
      nativePort = null;
      lastError = error;
      logger.warn("Native host disconnected", { error });
      scheduleReconnect();
    });
    nativePort.postMessage({ type: "extension_hello", version: chrome.runtime.getManifest().version });
  } catch (error) {
    nativeConnected = false;
    lastError = error instanceof Error ? error.message : String(error);
    logger.error("Failed to connect native host", { error: lastError });
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = globalThis.setTimeout(() => {
    reconnectTimer = null;
    void connectNative();
  }, 2_500) as unknown as number;
}

async function handleNativeMessage(message: unknown): Promise<void> {
  if (isObject(message) && message.type === "ping") {
    nativeConnected = true;
    postNative({ type: "pong", timestamp: Date.now() });
    return;
  }
  if (isObject(message) && message.type === "get_status") {
    nativeConnected = true;
    postNative({ type: "status_response", nativeConnected, state: await popupState() });
    return;
  }
  if (
    isObject(message) &&
    (message.type === "mcp_connected" ||
      message.type === "mcp_disconnected" ||
      message.type === "status_response" ||
      message.type === "notification")
  ) {
    nativeConnected = message.type !== "mcp_disconnected";
    logger.debug("Received native host notification", { type: String(message.type) });
    return;
  }
  nativeConnected = true;

  const request = normalizeToolRequest(message);
  if (!request) {
    postNative({
      type: "tool_response",
      requestId: "unknown",
      method: "unknown",
      isError: true,
      content: [{ type: "text", text: "Invalid tool request." }],
      structuredContent: {},
      error: { code: "invalid_request", message: "Invalid tool request.", retryable: false }
    });
    return;
  }

  const started = performance.now();
  const response = await dispatchToolRequest(request).catch((error: unknown) =>
    errorResponse(
      request,
      "error",
      "dispatch_error",
      error instanceof Error ? error.message : String(error),
      {},
      true
    )
  );
  response.meta = { ...(response.meta || {}), durationMs: Math.round(performance.now() - started) };
  const settings = await getSettings();
  postNative(enforcePayloadLimit(response, settings.maxPayloadBytes));
}

function postNative(message: unknown): void {
  if (!nativePort) return;
  try {
    nativePort.postMessage(message);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    logger.error("Failed to post native message", { error: lastError });
  }
}

async function dispatchToolRequest(request: ToolRequest): Promise<ToolResponse> {
  const method = request.method;
  const params = request.params || {};
  const settings = await getSettings();

  if (VISIBLE_CONTROL_TOOLS.has(method) && !settings.controlEnabled) {
    return errorResponse(request, "permission_required", "visible_control_disabled", "Browser control is paused in the Retina extension popup.", {}, true);
  }

  switch (method) {
    case "tabs_context_mcp":
      return tabsContext(request);
    case "tabs_create_mcp":
      return tabsCreate(request);
    case "read_page":
      return withPagePermission(request, () => readPage(request));
    case "get_page_text":
      return withPagePermission(request, () => getPageText(request));
    case "find":
      return withPagePermission(request, () => find(request));
    case "computer":
      return withPagePermission(request, () => computer(request, settings));
    case "navigate":
      return withPagePermission(request, () => navigate(request));
    case "read_console_messages":
      return withPagePermission(request, () => readConsoleMessages(request, settings));
    case "read_network_requests":
      return withPagePermission(request, () => readNetworkRequests(request, settings));
    case "form_input":
      return withPagePermission(request, () => formInput(request, settings));
    case "javascript_tool":
      return withPagePermission(request, () => javascriptTool(request, settings));
    case "resize_window":
      return resizeWindow(request);
    case "shortcuts_list":
      return shortcutsList(request);
    case "shortcuts_execute":
    case "gif_creator":
    case "upload_image":
    case "update_plan":
      return errorResponse(request, "unsupported", "deferred_tool", `${method} is intentionally deferred in this bridge build.`, { method }, false);
    default:
      return errorResponse(request, "unsupported", "unknown_tool", `Unsupported browser bridge tool: ${method}`, { method }, false);
  }
}

async function tabsContext(request: ToolRequest): Promise<ToolResponse> {
  const tabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll({ populate: false });
  const records: BrowserTabRecord[] = [];
  const candidates: BrowserCandidate[] = [];
  for (const tab of tabs.slice(0, 200)) {
    if (typeof tab.id !== "number") continue;
    const permissionState = await permissionStateForUrl(tab.url);
    const record: BrowserTabRecord = {
      id: `browser:tab:${tab.id}`,
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      focused: windows.some((win) => win.id === tab.windowId && win.focused && tab.active),
      status: tab.status,
      permissionState,
      ownedBySessionId: sessionTabs.get(tab.id)
    };
    records.push(record);
    candidates.push(tabCandidate(record));
  }
  return okResponse(request, { tabs: records, windows: windows.map((win) => ({ id: win.id, focused: win.focused, type: win.type })), candidates }, `Found ${records.length} browser tabs.`);
}

async function tabsCreate(request: ToolRequest): Promise<ToolResponse> {
  const params = request.params || {};
  const url = typeof params.url === "string" ? validateNavigationUrl(params.url) : undefined;
  if (params.url && !url) {
    return errorResponse(request, "error", "invalid_url", "The requested URL is not allowed for navigation.", { url: String(params.url) }, false);
  }
  const createProperties: chrome.tabs.CreateProperties = { active: params.active !== false };
  if (url) createProperties.url = url;
  const tab = (await chrome.tabs.create(createProperties)) as chrome.tabs.Tab;
  if (typeof tab.id === "number" && typeof params.sessionId === "string") {
    sessionTabs.set(tab.id, params.sessionId);
  }
  lastAction = `Created tab ${tab.id ?? "unknown"}`;
  return tabsContext(request);
}

async function readPage(request: ToolRequest): Promise<ToolResponse> {
  const tabId = await targetTabId(request);
  const response = await sendContent(tabId, { type: "retina_read_page", tabId, frameId: numberParam(request, "frameId") ?? 0 });
  if (!response.ok) return contentError(request, response);
  observe("page_read", "info", "Read page structure.", { tabId, candidateCount: response.candidates?.length || 0 });
  return okResponse(request, { title: response.title, url: response.url, text: response.text, candidates: response.candidates || [], activeElement: response.activeElement || {} }, `Read ${response.candidates?.length || 0} page candidates.`);
}

async function getPageText(request: ToolRequest): Promise<ToolResponse> {
  const tabId = await targetTabId(request);
  const response = await sendContent(tabId, { type: "retina_get_page_text", maxChars: numberParam(request, "maxChars") ?? 60_000 });
  if (!response.ok) return contentError(request, response);
  return okResponse(request, { title: response.title, url: response.url, text: response.text || "" }, response.text || "");
}

async function find(request: ToolRequest): Promise<ToolResponse> {
  const tabId = await targetTabId(request);
  const params = request.params || {};
  const response = await sendContent(tabId, {
    type: "retina_find",
    tabId,
    frameId: numberParam(request, "frameId") ?? 0,
    query: stringParam(params, "query") || stringParam(params, "text"),
    selector: stringParam(params, "selector"),
    role: stringParam(params, "role"),
    ref: stringParam(params, "ref") || stringParam(params, "candidateId")
  });
  if (!response.ok) return contentError(request, response);
  return okResponse(request, { candidates: response.matches || response.candidates || [], matches: response.matches || [] }, `Found ${(response.matches || []).length} matches.`);
}

async function computer(request: ToolRequest, settings: ExtensionSettings): Promise<ToolResponse> {
  const tabId = await targetTabId(request);
  const input = (request.params || {}) as ComputerActionInput;
  const beforeTab = await chrome.tabs.get(tabId).catch(() => null);
  const response = await sendContent(tabId, {
    type: "retina_computer",
    tabId,
    frameId: numberParam(request, "frameId") ?? 0,
    input,
    settings
  });
  if (!response.ok) {
    const status = candidateValidationError(response.code) ? "stale_candidate" : "error";
    observe("candidate_validation", "warn", "Browser candidate validation failed.", {
      tabId,
      action: input.action,
      code: response.code || "content_script_error",
      candidateId: input.candidateId || input.ref || null,
      details: response.details || {}
    });
    return errorResponse(
      request,
      status,
      response.code || "content_script_error",
      response.message || "Content script failed.",
      response.details || {},
      candidateValidationError(response.code)
    );
  }
  lastAction = `Computer action ${input.action}`;
  if (input.candidateId || input.ref || input.expected) {
    observe("candidate_validation", "info", "Browser candidate validation passed.", {
      tabId,
      action: input.action,
      candidateId: input.candidateId || input.ref || null
    });
  }
  observe("browser_action", "info", `Dispatched ${input.action}.`, { tabId, action: input.action, candidateId: input.candidateId || input.ref || null });

  const settle = shouldWaitForNavigation(input, request.params || {})
    ? await waitForNavigationSettle(tabId, beforeTab?.url, numberParam(request, "settleMs") ?? 2_500)
    : { navigated: false };

  if (settle.navigated) {
    const settledPage = await sendContent(tabId, { type: "retina_read_page", tabId, frameId: numberParam(request, "frameId") ?? 0 });
    if (settledPage.ok) {
      return okResponse(
        request,
        {
          title: settledPage.title,
          url: settledPage.url,
          candidates: settledPage.candidates || [],
          activeElement: settledPage.activeElement || {},
          navigation: settle
        },
        `Action ${input.action} dispatched and navigation settled.`
      );
    }
  }

  return okResponse(
    request,
    { candidates: response.candidates || [], activeElement: response.activeElement || {}, navigation: settle },
    response.text || `Dispatched ${input.action}.`
  );
}

async function formInput(request: ToolRequest, settings: ExtensionSettings): Promise<ToolResponse> {
  const params = request.params || {};
  return computer(
    {
      ...request,
      method: "computer",
      params: {
        action: "type",
        tabId: params.tabId,
        ref: stringParam(params, "ref") || stringParam(params, "selector") || stringParam(params, "candidateId"),
        text: stringParam(params, "text") || stringParam(params, "value") || ""
      }
    },
    settings
  );
}

async function navigate(request: ToolRequest): Promise<ToolResponse> {
  const tabId = await targetTabId(request);
  const url = validateNavigationUrl(stringParam(request.params || {}, "url") || "");
  if (!url) return errorResponse(request, "error", "invalid_url", "The requested URL is not allowed for navigation.", request.params || {}, false);
  await chrome.tabs.update(tabId, { url, active: true });
  lastAction = `Navigated tab ${tabId}`;
  observe("browser_action", "info", "Navigated tab.", { tabId, url });
  return okResponse(request, { tabId, url }, `Navigated to ${url}.`);
}

async function resizeWindow(request: ToolRequest): Promise<ToolResponse> {
  const tabId = await targetTabId(request);
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.windowId !== "number") return errorResponse(request, "tab_not_found", "window_not_found", "No window found for target tab.", { tabId }, true);
  const width = numberParam(request, "width");
  const height = numberParam(request, "height");
  if (!width || !height) return errorResponse(request, "error", "invalid_window_size", "resize_window requires width and height.", request.params || {}, false);
  await chrome.windows.update(tab.windowId, { width, height });
  return okResponse(request, { tabId, windowId: tab.windowId, width, height }, `Resized window to ${width}x${height}.`);
}

async function javascriptTool(request: ToolRequest, settings: ExtensionSettings): Promise<ToolResponse> {
  if (!settings.debuggerEnabled) {
    return errorResponse(request, "permission_required", "javascript_disabled", "JavaScript evaluation requires enabling debugger/elevated tools in the popup.", {}, false);
  }
  const tabId = await targetTabId(request);
  const expression = stringParam(request.params || {}, "code") || stringParam(request.params || {}, "expression");
  if (!expression) return errorResponse(request, "error", "missing_expression", "javascript_tool requires code or expression.", {}, false);
  await ensureDebugger(tabId, settings);
  const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 10_000
  });
  return okResponse(request, { result: redactValue(result) as JsonObject }, "JavaScript evaluation complete.");
}

async function readConsoleMessages(request: ToolRequest, settings: ExtensionSettings): Promise<ToolResponse> {
  const tabId = await targetTabId(request);
  await ensureDebugger(tabId, settings);
  const pattern = stringParam(request.params || {}, "pattern");
  const level = stringParam(request.params || {}, "level");
  const sinceMs = numberParam(request, "sinceMs") ?? 5 * 60_000;
  const cutoff = Date.now() - sinceMs;
  const events = debugEvents
    .filter((event) => event.tabId === tabId && event.kind === "console" && event.ts >= cutoff)
    .filter((event) => !level || event.level === level)
    .filter((event) => !pattern || new RegExp(pattern).test(event.message || ""))
    .slice(-200);
  return okResponse(request, { entries: redactValue(events) as unknown as JsonObject }, `Read ${events.length} console messages.`);
}

async function readNetworkRequests(request: ToolRequest, settings: ExtensionSettings): Promise<ToolResponse> {
  const tabId = await targetTabId(request);
  await ensureDebugger(tabId, settings);
  const pattern = stringParam(request.params || {}, "pattern");
  const sinceMs = numberParam(request, "sinceMs") ?? 5 * 60_000;
  const cutoff = Date.now() - sinceMs;
  const requests = debugEvents
    .filter((event) => event.tabId === tabId && event.kind === "network" && event.ts >= cutoff)
    .filter((event) => !pattern || new RegExp(pattern).test(event.url || ""))
    .slice(-300);
  return okResponse(request, { requests: redactValue(requests) as unknown as JsonObject, responseBodiesIncluded: false }, `Read ${requests.length} network requests.`);
}

function shortcutsList(request: ToolRequest): ToolResponse {
  return okResponse(request, {
    shortcuts: [
      { name: "pause_control", description: "Pause browser control from the popup." },
      { name: "resume_control", description: "Resume browser control from the popup." }
    ]
  }, "Shortcut list returned.");
}

async function withPagePermission(request: ToolRequest, dispatch: () => Promise<ToolResponse>): Promise<ToolResponse> {
  const params = request.params || {};
  if (!SITE_PERMISSION_TOOLS.has(request.method)) return dispatch();
  let tabId: number;
  try {
    tabId = await targetTabId(request);
  } catch {
    if (request.method === "tabs_create_mcp") return dispatch();
    throw new Error("No target tab is available.");
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const permission = await permissionStateForUrl(tab?.url);
  if (request.method === "navigate") {
    const destinationPermission = await permissionStateForUrl(stringParam(params, "url"));
    if (destinationPermission !== "granted") {
      return errorResponse(request, "permission_required", "origin_permission_required", "Grant the destination origin before navigating browser state.", { tabId, url: stringParam(params, "url") || null, permissionState: destinationPermission }, true);
    }
    return dispatch();
  }
  if (permission !== "granted" && MUTATING_TOOLS.has(request.method)) {
    return errorResponse(request, "permission_required", "origin_permission_required", "Grant this origin in the Retina extension popup before mutating browser state.", { tabId, url: tab?.url || null, permissionState: permission }, true);
  }
  if (permission !== "granted" && ["read_page", "get_page_text", "find", "read_console_messages", "read_network_requests"].includes(request.method)) {
    return errorResponse(request, "permission_required", "origin_permission_required", "Grant this origin in the Retina extension popup before reading page content.", { tabId, url: tab?.url || null, permissionState: permission }, true);
  }
  if (typeof params.sessionId === "string" && sessionTabs.has(tabId) && sessionTabs.get(tabId) !== params.sessionId) {
    return errorResponse(request, "permission_required", "tab_owned_by_another_session", "This tab is owned by another Retina browser session.", { tabId, owner: sessionTabs.get(tabId) }, true);
  }
  return dispatch();
}

async function sendContent(tabId: number, message: JsonObject): Promise<JsonObject & { ok: boolean; code?: string; message?: string; candidates?: BrowserCandidate[]; matches?: BrowserCandidate[]; text?: string; title?: string; url?: string; activeElement?: JsonObject; details?: JsonObject }> {
  try {
    await injectContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "content_script_unavailable",
      message: text,
      details: { tabId }
    };
  }
}

function shouldWaitForNavigation(input: ComputerActionInput, params: JsonObject): boolean {
  if (params.settle === false || params.waitForNavigation === false) return false;
  return input.action === "left_click" || input.action === "key";
}

async function waitForNavigationSettle(tabId: number, initialUrl: string | undefined, timeoutMs: number): Promise<NavigationSettleResult> {
  const started = Date.now();
  let observedNavigation = false;
  let lastUrl = initialUrl;
  let lastStatus = "";

  await delay(120);
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { navigated: observedNavigation, status: "missing" };
    lastUrl = tab.url;
    lastStatus = tab.status || "";
    if (tab.url && tab.url !== initialUrl) observedNavigation = true;
    if (tab.status === "loading") observedNavigation = true;
    if (observedNavigation && tab.status === "complete") {
      await delay(150);
      return { navigated: true, url: lastUrl, status: lastStatus };
    }
    await delay(100);
  }

  return observedNavigation
    ? { navigated: true, url: lastUrl, status: lastStatus, timedOut: true }
    : { navigated: false, url: lastUrl, status: lastStatus };
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ["content_script.js"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug("Content script injection failed", { tabId, message });
    throw error;
  }
}

async function ensureDebugger(tabId: number, settings: ExtensionSettings): Promise<void> {
  if (!settings.debuggerEnabled) {
    throw new Error("Debugger-backed tools are disabled in the popup.");
  }
  if (attachedDebugTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedDebugTabs.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Log.enable");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  logger.info("Attached debugger", { tabId });
}

function recordDebuggerEvent(tabId: number, method: string, params: JsonObject): void {
  if (method === "Runtime.consoleAPICalled") {
    const args = Array.isArray(params.args) ? params.args : [];
    debugEvents.push({
      tabId,
      ts: Date.now(),
      kind: "console",
      level: typeof params.type === "string" ? params.type : "log",
      message: args.map((arg) => (isObject(arg) && "value" in arg ? String(arg.value) : JSON.stringify(arg))).join(" "),
      data: params
    });
  } else if (method === "Log.entryAdded" && isObject(params.entry)) {
    debugEvents.push({
      tabId,
      ts: Date.now(),
      kind: "console",
      level: typeof params.entry.level === "string" ? params.entry.level : "log",
      message: typeof params.entry.text === "string" ? params.entry.text : "",
      url: typeof params.entry.url === "string" ? params.entry.url : undefined,
      data: params
    });
  } else if (method === "Network.requestWillBeSent") {
    debugEvents.push({
      tabId,
      ts: Date.now(),
      kind: "network",
      requestId: typeof params.requestId === "string" ? params.requestId : undefined,
      url: isObject(params.request) && typeof params.request.url === "string" ? params.request.url : undefined,
      method: isObject(params.request) && typeof params.request.method === "string" ? params.request.method : undefined,
      data: { requestId: params.requestId as string, request: params.request as JsonObject }
    });
  } else if (method === "Network.responseReceived") {
    debugEvents.push({
      tabId,
      ts: Date.now(),
      kind: "network",
      requestId: typeof params.requestId === "string" ? params.requestId : undefined,
      url: isObject(params.response) && typeof params.response.url === "string" ? params.response.url : undefined,
      status: isObject(params.response) && typeof params.response.status === "number" ? params.response.status : undefined,
      data: { requestId: params.requestId as string, response: params.response as JsonObject }
    });
  }
  while (debugEvents.length > 2_000) debugEvents.shift();
}

async function permissionStateForUrl(url: string | undefined): Promise<BrowserTabRecord["permissionState"]> {
  const origin = originPattern(url);
  if (!origin) return "blocked";
  const granted = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
  return granted ? "granted" : "withheld";
}

function originPattern(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

function validateNavigationUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

async function targetTabId(request: ToolRequest): Promise<number> {
  const fromParams = numberParam(request, "tabId");
  if (fromParams) return fromParams;
  const tab = await activeTab();
  if (typeof tab?.id === "number") return tab.id;
  throw new Error("No active browser tab is available.");
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

function tabCandidate(tab: BrowserTabRecord): BrowserCandidate {
  return {
    id: tab.id,
    source: "browser",
    role: "tab",
    displayName: tab.title || tab.url || `Tab ${tab.tabId}`,
    value: tab.url || null,
    identifier: String(tab.tabId),
    stableRef: `browser:tab:${tab.tabId}`,
    bounds: null,
    center: null,
    geometryState: "missing",
    actionCapabilities: ["browser_click"],
    rawFields: { ...tab }
  };
}

async function handlePopupMessage(message: unknown): Promise<JsonObject> {
  if (!isObject(message)) return { ok: false, message: "Invalid popup message." };
  if (message.type === "retina_popup_state") return { ok: true, state: await popupState() };
  if (message.type === "retina_toggle_control") {
    const settings = await getSettings();
    await setSettings({ ...settings, controlEnabled: Boolean(message.enabled) });
    return { ok: true, state: await popupState() };
  }
  if (message.type === "retina_toggle_debugger") {
    const settings = await getSettings();
    await setSettings({ ...settings, debuggerEnabled: Boolean(message.enabled) });
    return { ok: true, state: await popupState() };
  }
  if (message.type === "retina_grant_origin") {
    const tab = await activeTab();
    const origin = originPattern(tab?.url);
    if (!origin) return { ok: false, message: "This page cannot receive origin permission." };
    const granted = await chrome.permissions.request({ origins: [origin] });
    return { ok: granted, state: await popupState() };
  }
  if (message.type === "retina_revoke_origin") {
    const tab = await activeTab();
    const origin = originPattern(tab?.url);
    if (!origin) return { ok: false, message: "This page does not have a revocable origin." };
    await chrome.permissions.remove({ origins: [origin] });
    return { ok: true, state: await popupState() };
  }
  if (message.type === "retina_disconnect_native") {
    nativePort?.disconnect();
    nativePort = null;
    nativeConnected = false;
    return { ok: true, state: await popupState() };
  }
  return { ok: false, message: "Unknown popup message." };
}

async function popupState(): Promise<PopupState> {
  const settings = await getSettings();
  const tab = await activeTab();
  const activeTabRecord =
    typeof tab?.id === "number"
      ? {
          id: `browser:tab:${tab.id}`,
          tabId: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          focused: true,
          status: tab.status,
          permissionState: await permissionStateForUrl(tab.url),
          ownedBySessionId: sessionTabs.get(tab.id)
        }
      : undefined;
  return {
    extensionId: chrome.runtime.id,
    nativeConnected,
    controlEnabled: settings.controlEnabled,
    debuggerEnabled: settings.debuggerEnabled,
    activeTab: activeTabRecord,
    lastAction,
    lastError,
    sessions: Array.from(new Set(sessionTabs.values()))
  };
}

async function ensureDefaultSettings(): Promise<void> {
  const settings = await getSettings();
  await setSettings(settings);
}

async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(isObject(stored.settings) ? stored.settings : {}) };
}

async function setSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

function contentError(request: ToolRequest, response: { code?: string; message?: string; details?: JsonObject }): ToolResponse {
  return errorResponse(request, "error", response.code || "content_script_error", response.message || "Content script failed.", response.details || {}, true);
}

function observe(category: Parameters<typeof logger.observation>[0]["category"], severity: Parameters<typeof logger.observation>[0]["severity"], message: string, data: JsonObject): void {
  logger.observation({ v: 1, type: "event", event: "observation", category, severity, message, data });
}

function candidateValidationError(code: string | undefined): boolean {
  return [
    "stale_candidate",
    "candidate_mismatch",
    "candidate_not_visible",
    "candidate_disabled",
    "coordinate_mismatch",
    "type_target_not_editable",
    "type_value_mismatch",
    "type_no_change"
  ].includes(code || "");
}

function stringParam(params: JsonObject, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function numberParam(request: ToolRequest, key: string): number | undefined {
  const value = (request.params || {})[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
