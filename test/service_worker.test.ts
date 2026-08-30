import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, EXTENSION_ID, NATIVE_HOST_ID } from "../src/shared/constants";

type Listener = (...args: any[]) => any;

function eventSlot() {
  let listener: Listener | undefined;
  return {
    api: {
      addListener: vi.fn((next: Listener) => {
        listener = next;
      }),
      removeListener: vi.fn()
    },
    emit: (...args: any[]) => listener?.(...args),
    listener: () => listener
  };
}

function chromeHarness(options: { controlEnabled?: boolean; originGranted?: boolean; childFrame?: boolean } = {}) {
  const nativeMessage = eventSlot();
  const nativeDisconnect = eventSlot();
  const runtimeInstalled = eventSlot();
  const runtimeStartup = eventSlot();
  const runtimeMessage = eventSlot();
  const tabRemoved = eventSlot();
  const posted: any[] = [];
  let frameEnumerationCount = 0;
  let settings = {
    ...DEFAULT_SETTINGS,
    controlEnabled: options.controlEnabled ?? true
  };

  const port = {
    onMessage: nativeMessage.api,
    onDisconnect: nativeDisconnect.api,
    postMessage: vi.fn((message: unknown) => posted.push(message)),
    disconnect: vi.fn()
  };
  const activeTab = {
    id: 17,
    windowId: 3,
    active: true,
    status: "complete",
    title: "Retina fixture",
    url: "http://127.0.0.1:4173/form.html"
  };

  const chromeMock = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      connectNative: vi.fn((host: string) => {
        expect(host).toBe(NATIVE_HOST_ID);
        return port;
      }),
      getManifest: vi.fn(() => ({ version: "0.1.0" })),
      onInstalled: runtimeInstalled.api,
      onStartup: runtimeStartup.api,
      onMessage: runtimeMessage.api
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ settings })),
        set: vi.fn(async (value: { settings?: typeof settings }) => {
          if (value.settings) settings = value.settings;
        })
      }
    },
    permissions: {
      contains: vi.fn(async () => options.originGranted ?? false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true)
    },
    tabs: {
      query: vi.fn(async (query: { active?: boolean } = {}) =>
        query.active === false ? [] : [activeTab]
      ),
      create: vi.fn(),
      update: vi.fn(),
      get: vi.fn(async () => activeTab),
      sendMessage: vi.fn(async (_tabId: number, _message: unknown, target?: { frameId?: number }) => ({
        ok: true,
        candidates: target?.frameId === 12
          ? [{ id: "browser:17:12:iframe-note", displayName: "Iframe Note", rawFields: { chromeFrameId: 12 } }]
          : [],
        text: "",
        title: "Retina fixture",
        url: activeTab.url
      })),
      onRemoved: tabRemoved.api
    },
    windows: {
      getAll: vi.fn(async () => [{ id: 3, focused: true, type: "normal" }]),
      update: vi.fn()
    },
    scripting: {
      executeScript: vi.fn(async () => [{ frameId: 0 }])
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => options.childFrame && ++frameEnumerationCount > 1
        ? [
            { frameId: 0, parentFrameId: -1, url: activeTab.url },
            { frameId: 12, parentFrameId: 0, url: "about:srcdoc" }
          ]
        : [{ frameId: 0, parentFrameId: -1, url: activeTab.url }])
    }
  };

  return {
    chromeMock,
    nativeMessage,
    nativeDisconnect,
    runtimeMessage,
    posted,
    settings: () => settings
  };
}

async function importWorker(harness: ReturnType<typeof chromeHarness>) {
  vi.stubGlobal("chrome", harness.chromeMock);
  await import("../src/extension/service_worker");
}

async function responseFor(harness: ReturnType<typeof chromeHarness>, requestId: string) {
  await vi.waitFor(() => {
    expect(
      harness.posted.some(
        (message) => message?.type === "tool_response" && message?.requestId === requestId
      )
    ).toBe(true);
  });
  return harness.posted.find(
    (message) => message?.type === "tool_response" && message?.requestId === requestId
  );
}

describe("service worker control boundaries", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects to the Retina native host after the source 2500ms delay", async () => {
    vi.useFakeTimers();
    const harness = chromeHarness();
    await importWorker(harness);

    expect(harness.chromeMock.runtime.connectNative).toHaveBeenCalledTimes(1);
    harness.nativeDisconnect.emit();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(harness.chromeMock.runtime.connectNative).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.chromeMock.runtime.connectNative).toHaveBeenCalledTimes(2);
  });

  it("refuses visible browser control while the popup pause is active", async () => {
    const harness = chromeHarness({ controlEnabled: false, originGranted: true });
    await importWorker(harness);

    harness.nativeMessage.emit({
      type: "tool_request",
      method: "computer",
      params: { action: "left_click", tabId: 17, ref: "#submit" },
      requestId: "paused"
    });
    const response = await responseFor(harness, "paused");

    expect(response.isError).toBe(true);
    expect(response.status).toBe("permission_required");
    expect(response.error?.code).toBe("visible_control_disabled");
    expect(response.error?.retryable).toBe(true);
    expect(harness.chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("allows page reads immediately without a per-origin grant", async () => {
    const harness = chromeHarness({ originGranted: false });
    await importWorker(harness);

    harness.nativeMessage.emit({
      type: "tool_request",
      method: "read_page",
      params: { tabId: 17 },
      requestId: "origin-denied"
    });
    const response = await responseFor(harness, "origin-denied");

    expect(response.isError).toBe(false);
    expect(response.status).toBe("ok");
    expect(harness.chromeMock.permissions.contains).not.toHaveBeenCalled();
    expect(harness.chromeMock.tabs.sendMessage).toHaveBeenCalled();
  });

  it("routes an iframe action using the Chrome frame id alias", async () => {
    const harness = chromeHarness();
    await importWorker(harness);

    harness.nativeMessage.emit({
      type: "tool_request",
      method: "computer",
      params: { action: "type", tabId: 17, chromeFrameId: 12, ref: "#note", text: "iframe note" },
      requestId: "iframe-action"
    });
    const response = await responseFor(harness, "iframe-action");

    expect(response.isError).toBe(false);
    expect(harness.chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      17,
      expect.objectContaining({ frameId: 12 }),
      { frameId: 12 }
    );
  });

  it("logs browser actions without candidate references or typed values", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const harness = chromeHarness();
    await importWorker(harness);

    harness.nativeMessage.emit({
      type: "tool_request",
      method: "computer",
      params: {
        action: "set_value",
        tabId: 17,
        candidateId: "opaque-sensitive-control-id",
        text: "typed-private-value"
      },
      requestId: "private-action"
    });
    const response = await responseFor(harness, "private-action");
    const serializedLogs = log.mock.calls.flat().join("\n");

    expect(response.isError).toBe(false);
    expect(serializedLogs).toContain('"actionKind":"set_value"');
    expect(serializedLogs).toContain('"targetProvided":true');
    expect(serializedLogs).not.toContain("opaque-sensitive-control-id");
    expect(serializedLogs).not.toContain("typed-private-value");
  });

  it("discovers candidates in related-origin frames omitted by programmatic injection", async () => {
    const harness = chromeHarness({ childFrame: true });
    await importWorker(harness);

    harness.nativeMessage.emit({
      type: "tool_request",
      method: "read_page",
      params: { tabId: 17 },
      requestId: "iframe-read"
    });
    const response = await responseFor(harness, "iframe-read");

    expect(response.isError).toBe(false);
    expect(response.structuredContent.candidates).toEqual([
      expect.objectContaining({ displayName: "Iframe Note", rawFields: { chromeFrameId: 12 } })
    ]);
    expect(harness.chromeMock.webNavigation.getAllFrames.mock.calls.length).toBeGreaterThan(1);
    expect(harness.chromeMock.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 17 });
    expect(harness.chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      17,
      expect.objectContaining({ frameId: 12 }),
      { frameId: 12 }
    );
  });

  it("routes the popup pause control through persisted extension state", async () => {
    const harness = chromeHarness();
    await importWorker(harness);

    const callPopup = (message: unknown) =>
      new Promise<any>((resolve) => {
        expect(harness.runtimeMessage.emit(message, {}, resolve)).toBe(true);
      });

    const pause = await callPopup({ type: "retina_toggle_control", enabled: false });
    expect(pause.ok).toBe(true);
    expect(harness.settings().controlEnabled).toBe(false);
  });
});
