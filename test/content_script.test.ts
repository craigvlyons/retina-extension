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
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: vi.fn(() => document.body)
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

  it("set_value replaces a number input instead of appending at its cursor", async () => {
    document.body.innerHTML = `<label for="retention-days">Artifact and log retention</label><input id="retention-days" type="number" value="90">`;
    await loadContentScript();

    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: {
        action: "set_value",
        ref: "#retention-days",
        text: "88",
        expected: { text: "88" }
      },
      settings: { actionJitterMs: 0 }
    });

    expect(response).toMatchObject({ ok: true });
    expect((document.getElementById("retention-days") as HTMLInputElement).value).toBe("88");
  });

  it("set_value fails closed when a controlled input restores its old value after dispatch", async () => {
    document.body.innerHTML = `<label for="retention-days">Artifact and log retention</label><input id="retention-days" type="number" value="90">`;
    const input = document.getElementById("retention-days") as HTMLInputElement;
    input.addEventListener("input", () => {
      setTimeout(() => {
        input.value = "90";
      }, 1);
    });
    await loadContentScript();

    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: {
        action: "set_value",
        ref: "#retention-days",
        text: "88"
      },
      settings: { actionJitterMs: 0, postActionSettleMs: 50 }
    });

    expect(response).toMatchObject({ ok: false, code: "type_no_change" });
    expect(input.value).toBe("90");
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

  it("activates a submit button exactly once and preserves the submitter", async () => {
    document.body.innerHTML = `
      <form id="form">
        <input name="retention" value="88">
        <button id="save" type="submit" aria-label="Save retention">Save</button>
      </form>`;
    const form = document.getElementById("form") as HTMLFormElement;
    const button = document.getElementById("save") as HTMLButtonElement;
    let clickCount = 0;
    let submitCount = 0;
    let submitter: HTMLElement | null = null;
    button.addEventListener("click", () => {
      clickCount += 1;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitCount += 1;
      submitter = (event as SubmitEvent).submitter as HTMLElement | null;
    });
    await loadContentScript();

    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: { action: "left_click", ref: "#save" },
      settings: { actionJitterMs: 0 }
    });

    expect(response).toMatchObject({ ok: true });
    expect(clickCount).toBe(1);
    expect(submitCount).toBe(1);
    expect(submitter).toBe(button);
  });

  it("prefers the expected stable reference over a non-unique structural selector", async () => {
    document.body.innerHTML = `
      <section id="first">
        <retention-form><form><div><div>
          <button type="button" aria-label="Save cache retention">Save</button>
        </div></div></form></retention-form>
      </section>
      <section id="second">
        <retention-form><form><div><div>
          <button type="button" aria-label="Save artifact retention">Save</button>
        </div></div></form></retention-form>
      </section>`;
    await loadContentScript();

    const snapshot = await sendContentMessage({ type: "retina_read_page", tabId: 7, frameId: 0 });
    const target = (snapshot.candidates as Array<any>)
      .find((candidate) => candidate.displayName === "Save artifact retention");
    const buttons = Array.from(document.querySelectorAll("button"));
    const clicks = buttons.map(() => 0);
    buttons.forEach((button, index) => button.addEventListener("click", () => {
      clicks[index] += 1;
    }));

    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: {
        action: "left_click",
        ref: "retention-form > form > div > div > button",
        expected: {
          identifier: target.identifier,
          stableRef: target.stableRef
        }
      },
      settings: { actionJitterMs: 0 }
    });

    expect(response).toMatchObject({ ok: true });
    expect(clicks).toEqual([0, 1]);
  });

  it("does not fall back to a selector when the expected stable reference is stale", async () => {
    document.body.innerHTML = `<button id="available" type="button">Available</button>`;
    const button = document.getElementById("available") as HTMLButtonElement;
    const click = vi.spyOn(button, "click");
    await loadContentScript();

    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: {
        action: "left_click",
        ref: "#available",
        expected: { stableRef: "dom:stale-private-reference" }
      },
      settings: { actionJitterMs: 0 }
    });

    expect(response).toMatchObject({ ok: false, code: "stale_candidate" });
    expect(click).not.toHaveBeenCalled();
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

  it("discovers and targets controls inside open shadow roots", async () => {
    document.body.innerHTML = `<div id="shadow-host"></div>`;
    const shadow = document.getElementById("shadow-host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<label>Shadow Code <input data-retina-ref="shadow-code" aria-label="Shadow Code"></label>`;
    await loadContentScript();

    const snapshot = await sendContentMessage({ type: "retina_read_page", tabId: 7, frameId: 0 });
    const candidate = (snapshot.candidates as Array<any>).find((item) => item.displayName === "Shadow Code");
    expect(candidate).toMatchObject({
      identifier: `[data-retina-ref="shadow-code"]`,
      rawFields: { framePath: "#shadow-host#shadow" }
    });

    const action = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      frameId: 0,
      input: { action: "type", ref: candidate.stableRef, text: "shadow-42" },
      settings: { actionJitterMs: 0 }
    });
    expect(action).toMatchObject({ ok: true });
    expect((shadow.querySelector("input") as HTMLInputElement).value).toBe("shadow-42");
  });

  it("adds bounded semantic ancestry without editable values or selectors", async () => {
    document.body.innerHTML = `
      <main aria-label="Account settings">
        <section role="region" aria-label="Account security">
          <h2>Password and authentication</h2>
          <div><button id="settings">Settings</button></div>
          <label>Secret <input value="typed-private-value"></label>
        </section>
      </main>`;
    await loadContentScript();

    const response = await sendContentMessage({ type: "retina_read_page", tabId: 7 });
    const candidate = (response.candidates as Array<any>).find((item) => item.displayName === "Settings");
    expect(candidate.rawFields.semanticAncestry).toEqual([
      "[main] Account settings",
      "[region] Account security — Password and authentication"
    ]);
    const ancestryWire = JSON.stringify(candidate.rawFields.semanticAncestry);
    expect(ancestryWire).not.toContain("typed-private-value");
    expect(ancestryWire).not.toContain("#settings");
  });

  it("separates trusted editable names from placeholder and current value", async () => {
    document.body.innerHTML = `
      <label for="retention">Artifact retention days</label>
      <input id="retention" placeholder="days" value="typed-private-value">
      <input id="unlabelled" placeholder="Search private text" value="another-private-value">`;
    await loadContentScript();

    const response = await sendContentMessage({ type: "retina_read_page", tabId: 7 });
    const candidates = response.candidates as Array<any>;
    const labelled = candidates.find((item) => item.rawFields?.accessibleName === "Artifact retention days");
    const unlabelled = candidates.find((item) => item.identifier === "#unlabelled");

    expect(labelled.rawFields).toMatchObject({
      accessibleName: "Artifact retention days",
      accessibleNameSource: "html_label",
      accessibleNameTrusted: true
    });
    expect(labelled.rawFields.accessibleName).not.toContain("typed-private-value");
    expect(unlabelled.displayName).toBe("Search private text");
    expect(unlabelled.rawFields).toMatchObject({
      accessibleName: null,
      accessibleNameSource: "none",
      accessibleNameTrusted: false
    });
    expect(unlabelled.rawFields.accessibleName).not.toBe("another-private-value");
  });

  it("maps native input roles and advertises only compatible actions", async () => {
    document.body.innerHTML = `
      <label><input id="allow-all" type="radio" name="policy"> Allow all actions</label>
      <label for="retention">Artifact and log retention</label>
      <input id="retention" type="number" value="90">
      <input id="volume" type="range" min="0" max="10" value="5">
      <h2 aria-label="Read-only heading">Read-only heading</h2>`;
    await loadContentScript();

    const response = await sendContentMessage({ type: "retina_read_page", tabId: 7 });
    const candidates = response.candidates as Array<any>;
    const radio = candidates.find((item) => item.identifier === "#allow-all");
    const retention = candidates.find((item) => item.identifier === "#retention");
    const range = candidates.find((item) => item.identifier === "#volume");
    const heading = candidates.find((item) => item.displayName === "Read-only heading" && item.role === "heading");

    expect(radio).toMatchObject({
      role: "radio",
      actionCapabilities: expect.arrayContaining(["browser_click", "press"])
    });
    expect(radio.actionCapabilities).not.toContain("type");
    expect(radio.actionCapabilities).not.toContain("set_value");
    expect(radio.actionCapabilities).not.toContain("scroll");
    expect(radio.actionCapabilities).not.toContain("drag");

    expect(retention).toMatchObject({
      role: "spinbutton",
      actionCapabilities: expect.arrayContaining(["type", "set_value", "press"])
    });
    expect(retention.actionCapabilities).not.toContain("scroll");
    expect(retention.actionCapabilities).not.toContain("drag");

    expect(range).toMatchObject({
      role: "slider",
      actionCapabilities: expect.arrayContaining(["set_value", "press", "drag"])
    });
    expect(range.actionCapabilities).not.toContain("type");
    expect(heading.actionCapabilities).toEqual([]);
  });

  it("does not trust aria-labelledby references to editable values", async () => {
    document.body.innerHTML = `
      <input id="source" value="private-source-value">
      <input id="target" aria-labelledby="source" value="private-target-value">`;
    await loadContentScript();

    const response = await sendContentMessage({ type: "retina_read_page", tabId: 7 });
    const target = (response.candidates as Array<any>).find((item) => item.identifier === "#target");
    expect(target.rawFields).toMatchObject({
      accessibleName: null,
      accessibleNameSource: "none",
      accessibleNameTrusted: false
    });
    expect(target.rawFields.accessibleName).not.toBe("private-source-value");
    expect(target.rawFields.accessibleName).not.toBe("private-target-value");
  });

  it("does not use an unlabelled editable value as display or stable identity", async () => {
    document.body.innerHTML = `<input class="ephemeral" value="first-private-value">`;
    await loadContentScript();

    const firstResponse = await sendContentMessage({ type: "retina_read_page", tabId: 7 });
    const first = (firstResponse.candidates as Array<any>).find((item) => item.rawFields?.tagName === "input");
    (document.querySelector("input") as HTMLInputElement).value = "second-private-value";
    const secondResponse = await sendContentMessage({ type: "retina_read_page", tabId: 7 });
    const second = (secondResponse.candidates as Array<any>).find((item) => item.rawFields?.tagName === "input");

    expect(first.displayName).toBe("textbox");
    expect(second.displayName).toBe("textbox");
    expect(first.stableRef).toBe(second.stableRef);
    expect(first.displayName).not.toContain("first-private-value");
    expect(second.displayName).not.toContain("second-private-value");
  });

  it("selects an option by its human-readable label", async () => {
    document.body.innerHTML = `<label for="state">State</label><select id="state"><option value="CO">Colorado</option><option value="WY">Wyoming</option></select>`;
    await loadContentScript();

    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: { action: "select", ref: "#state", text: "Wyoming", expected: { text: "Wyoming" } },
      settings: { actionJitterMs: 0 }
    });

    expect(response).toMatchObject({ ok: true });
    expect((document.getElementById("state") as HTMLSelectElement).value).toBe("WY");
  });

  it("validates and clicks document coordinates after the page scrolls", async () => {
    document.body.innerHTML = `<button id="scrolled">Open Modal</button>`;
    vi.spyOn(window, "scrollY", "get").mockReturnValue(780);
    const button = document.getElementById("scrolled") as HTMLButtonElement;
    (document.elementFromPoint as ReturnType<typeof vi.fn>).mockReturnValue(button);
    const click = vi.spyOn(button, "click");
    await loadContentScript();

    const response = await sendContentMessage({
      type: "retina_computer",
      tabId: 7,
      input: { action: "left_click", ref: "#scrolled", coordinate: [60, 792] },
      settings: { actionJitterMs: 0 }
    });

    expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
    expect(click).toHaveBeenCalledOnce();
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
