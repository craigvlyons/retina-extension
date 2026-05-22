import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MessageListener = (request: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;

let listeners: MessageListener[];
describe("content script bridge", () => {
  beforeEach(() => {
    listeners = [];
    document.body.innerHTML = "";
    delete (globalThis as typeof globalThis & { __retinaBridgeContentScript?: unknown }).__retinaBridgeContentScript;
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 120,
      bottom: 24,
      width: 120,
      height: 24,
      toJSON: () => ({})
    } as DOMRect);
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: MessageListener) => {
            listeners.push(listener);
          })
        }
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("installs only one runtime listener when reinjected", async () => {
    await loadContentScript();
    await loadContentScript();

    expect(listeners).toHaveLength(1);
  });

  it("types into an editable target exactly once after reinjection", async () => {
    document.body.innerHTML = `<label for="query">Query</label><textarea id="query" name="q"></textarea>`;
    await loadContentScript();
    await loadContentScript();

    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: {
        action: "type",
        ref: `textarea[name="q"]`,
        text: "retina bridge"
      },
      settings: { actionJitterMs: 0 }
    });

    expect(response).toMatchObject({ ok: true });
    expect((document.querySelector(`textarea[name="q"]`) as HTMLTextAreaElement).value).toBe("retina bridge");
  });

  it("submits the active form on Enter", async () => {
    document.body.innerHTML = `
      <form id="form">
        <input id="query" name="q">
        <output id="result"></output>
      </form>`;
    const input = document.getElementById("query") as HTMLInputElement;
    const form = document.getElementById("form") as HTMLFormElement;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      (document.getElementById("result") as HTMLOutputElement).value = input.value;
    });
    await loadContentScript();

    await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: { action: "type", ref: "#query", text: "submitted value" },
      settings: { actionJitterMs: 0 }
    });
    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: { action: "key", key: "Enter" },
      settings: { actionJitterMs: 0 }
    });

    expect(response).toMatchObject({ ok: true });
    expect((document.getElementById("result") as HTMLOutputElement).value).toBe("submitted value");
  });

  it("removes embedded style text from candidate labels", async () => {
    document.body.innerHTML = `
      <main role="main">
        <style>.MagqMc .ZFiwCf{background-color:#2c2e35;width:100%}</style>
        <button id="clean">Visible Button</button>
      </main>`;
    await loadContentScript();

    const response = await sendContentMessage({ type: "retina_read_page", tabId: 7 });
    const text = JSON.stringify(response);

    expect(text).toContain("Visible Button");
    expect(text).not.toContain("background-color");
    expect(text).not.toContain("MagqMc");
  });
});

async function loadContentScript(): Promise<void> {
  vi.resetModules();
  await import("../src/extension/content_script");
}

async function sendContentMessage(request: unknown): Promise<Record<string, unknown>> {
  const listener = listeners[0];
  if (!listener) throw new Error("Content script listener was not installed.");
  const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
    listener(request, {}, (response) => resolve(response as Record<string, unknown>));
  });
  await vi.runAllTimersAsync();
  return responsePromise;
}
