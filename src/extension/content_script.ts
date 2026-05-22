import type { BrowserCandidate, ComputerActionInput, JsonObject, Rect } from "../shared/types";

type ContentRequest =
  | { type: "retina_read_page"; tabId: number; frameId?: number; includeHidden?: boolean }
  | { type: "retina_get_page_text"; maxChars?: number }
  | { type: "retina_find"; tabId: number; frameId?: number; query?: string; selector?: string; role?: string; ref?: string }
  | { type: "retina_computer"; tabId: number; frameId?: number; input: ComputerActionInput; settings?: JsonObject };

type ContentResponse =
  | { ok: true; text?: string; title?: string; url?: string; candidates?: BrowserCandidate[]; matches?: BrowserCandidate[]; activeElement?: JsonObject }
  | { ok: false; code: string; message: string; details?: JsonObject };

const interactiveSelector = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[role]",
  "[tabindex]",
  "[contenteditable='true']",
  "[data-testid]",
  "[aria-label]",
  "[onclick]"
].join(",");

const CANDIDATE_TEXT_MAX = 240;

const globalState = globalThis as typeof globalThis & {
  __retinaBridgeContentScript?: {
    listenerInstalled: boolean;
    refToElement: Map<string, WeakRef<Element>>;
  };
};
const contentState =
  globalState.__retinaBridgeContentScript ??
  (globalState.__retinaBridgeContentScript = {
    listenerInstalled: false,
    refToElement: new Map<string, WeakRef<Element>>()
  });
const refToElement = contentState.refToElement;

if (!contentState.listenerInstalled) {
  contentState.listenerInstalled = true;
  chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
    void handleRequest(request).then(sendResponse).catch((error: unknown) => {
      sendResponse({
        ok: false,
        code: "content_script_error",
        message: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  });
}

async function handleRequest(request: ContentRequest): Promise<ContentResponse> {
  switch (request.type) {
    case "retina_read_page":
      return readPage(request.tabId, request.frameId ?? 0, request.includeHidden ?? false);
    case "retina_get_page_text":
      return { ok: true, text: readableText(request.maxChars ?? 60_000), title: document.title, url: location.href };
    case "retina_find":
      return findCandidates(request);
    case "retina_computer":
      return executeComputerAction(request.tabId, request.frameId ?? 0, request.input, request.settings || {});
    default:
      return { ok: false, code: "unsupported_content_message", message: "Unsupported content-script message." };
  }
}

function readPage(tabId: number, frameId: number, includeHidden: boolean): ContentResponse {
  const candidates = collectCandidates(tabId, frameId, includeHidden);
  return {
    ok: true,
    title: document.title,
    url: location.href,
    text: readableText(80_000),
    candidates,
    activeElement: describeActiveElement(tabId, frameId)
  };
}

function findCandidates(request: Extract<ContentRequest, { type: "retina_find" }>): ContentResponse {
  const tabId = request.tabId;
  const frameId = request.frameId ?? 0;
  let elements: Element[] = [];
  if (request.ref) {
    const element = resolveElement(request.ref);
    elements = element ? [element] : [];
  } else if (request.selector) {
    elements = safeQueryAll(request.selector);
  } else {
    const query = (request.query || request.role || "").trim().toLocaleLowerCase();
    elements = collectElements(true).filter((element) => {
      const candidate = elementToCandidate(element, tabId, frameId, true);
      if (!candidate) return false;
      const haystack = [
        candidate.role,
        candidate.displayName,
        candidate.value,
        candidate.identifier,
        candidate.stableRef,
        candidate.rawFields.text
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return !query || haystack.includes(query);
    });
  }
  const matches = elements
    .map((element) => elementToCandidate(element, tabId, frameId, true))
    .filter((candidate): candidate is BrowserCandidate => Boolean(candidate))
    .slice(0, 200);
  return { ok: true, matches, candidates: matches, title: document.title, url: location.href };
}

async function executeComputerAction(
  tabId: number,
  frameId: number,
  input: ComputerActionInput,
  settings: JsonObject
): Promise<ContentResponse> {
  if (input.action === "wait") {
    await delay(numberSetting(settings, "amount", 500));
    return { ok: true, text: "Wait complete.", candidates: collectCandidates(tabId, frameId, false).slice(0, 40) };
  }

  const target = input.ref || input.candidateId || input.expected?.stableRef || input.expected?.identifier;
  const element = target ? resolveElement(target) : elementFromCoordinate(input.coordinate);
  if (!element && input.action !== "scroll" && input.action !== "key" && !input.coordinate) {
    return {
      ok: false,
      code: "stale_candidate",
      message: "The requested browser candidate is no longer available.",
      details: { ref: target || null }
    };
  }

  if (element) {
    const validation = validateCandidate(element, input);
    if (!validation.ok) return validation;
  }

  switch (input.action) {
    case "left_click":
      await humanClick(element, input.coordinate, settings);
      break;
    case "type":
      await humanType(element, input.text ?? "", settings);
      break;
    case "key":
      await humanKey(element, input.key || input.text || "", settings);
      break;
    case "scroll":
      await humanScroll(element, input, settings);
      break;
    case "left_click_drag":
      await humanDrag(element, input, settings);
      break;
    default:
      return {
        ok: false,
        code: "unsupported_action",
        message: `Unsupported computer action: ${input.action}`,
        details: { action: input.action }
      };
  }

  const fresh = element ? elementToCandidate(element, tabId, frameId, true) : null;
  return {
    ok: true,
    text: `Action ${input.action} dispatched.`,
    candidates: fresh ? [fresh, ...collectCandidates(tabId, frameId, false).slice(0, 39)] : collectCandidates(tabId, frameId, false).slice(0, 40),
    activeElement: describeActiveElement(tabId, frameId)
  };
}

function collectCandidates(tabId: number, frameId: number, includeHidden: boolean): BrowserCandidate[] {
  return collectElements(includeHidden)
    .map((element) => elementToCandidate(element, tabId, frameId, includeHidden))
    .filter((candidate): candidate is BrowserCandidate => Boolean(candidate))
    .slice(0, 500);
}

function collectElements(includeHidden: boolean): Element[] {
  const elements = new Set<Element>();
  for (const element of Array.from(document.querySelectorAll(interactiveSelector))) {
    if (includeHidden || isCandidateVisible(element)) elements.add(element);
  }
  for (const heading of Array.from(document.querySelectorAll("h1,h2,h3,label,[aria-live]"))) {
    if (includeHidden || isCandidateVisible(heading)) elements.add(heading);
  }
  return Array.from(elements);
}

function elementToCandidate(
  element: Element,
  tabId: number,
  frameId: number,
  includeHidden: boolean
): BrowserCandidate | null {
  const visible = isCandidateVisible(element);
  if (!includeHidden && !visible) return null;
  const rect = element.getBoundingClientRect();
  const bounds = rectToBounds(rect);
  const stableRef = stableReference(element);
  const role = ariaRole(element);
  const rawText = textFor(element);
  const displayName = truncate(accessibleName(element) || rawText || role || element.tagName.toLowerCase(), CANDIDATE_TEXT_MAX);
  const identifier = selectorFor(element) || stableRef;
  const enabled = !isDisabled(element);
  refToElement.set(stableRef, new WeakRef(element));
  if (identifier) refToElement.set(identifier, new WeakRef(element));
  return {
    id: `browser:${tabId}:${frameId}:${stableRef}`,
    source: "browser",
    role,
    displayName,
    value: valueFor(element),
    identifier,
    stableRef,
    bounds,
    center: bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : null,
    geometryState: bounds ? "known" : "missing",
    actionCapabilities: actionCapabilities(element, enabled),
    rawFields: {
      tabId,
      frameId,
      url: location.href,
      cssSelector: selectorFor(element),
      xpath: xpathFor(element),
      ariaRole: role,
      accessibleName: displayName,
      text: rawText,
      tagName: element.tagName.toLowerCase(),
      isVisible: visible,
      isEnabled: enabled
    }
  };
}

function actionCapabilities(element: Element, enabled: boolean): BrowserCandidate["actionCapabilities"] {
  const caps: BrowserCandidate["actionCapabilities"] = [];
  if (!enabled) return caps;
  const tag = element.tagName.toLowerCase();
  const role = ariaRole(element);
  if (["button", "a", "summary", "option"].includes(tag) || role === "button" || role === "link" || element.hasAttribute("onclick")) {
    caps.push("browser_click");
  }
  if (isEditable(element)) caps.push("type", "set_value");
  caps.push("press", "scroll", "drag");
  return Array.from(new Set(caps));
}

function resolveElement(ref: string): Element | null {
  const normalized = ref.replace(/^browser:\d+:\d+:/, "");
  const weak = refToElement.get(ref) || refToElement.get(normalized);
  const cached = weak?.deref();
  if (cached?.isConnected) return cached;
  if (ref.startsWith("#") || ref.includes("[") || ref.includes(">") || /^[a-z][\w-]*/i.test(ref)) {
    const selected = safeQueryAll(ref)[0];
    if (selected) return selected;
  }
  return collectElements(true).find((element) => stableReference(element) === normalized || selectorFor(element) === ref) || null;
}

function validateCandidate(element: Element, input: ComputerActionInput): ContentResponse | { ok: true } {
  if (input.expected?.stableRef && !input.expected.stableRef.endsWith(stableReference(element))) {
    return {
      ok: false,
      code: "candidate_mismatch",
      message: "Candidate no longer matches the expected stable reference.",
      details: { expected: input.expected.stableRef, actual: stableReference(element) }
    };
  }
  if (input.expected?.identifier && selectorFor(element) !== input.expected.identifier && stableReference(element) !== input.expected.identifier) {
    return {
      ok: false,
      code: "candidate_mismatch",
      message: "Candidate no longer matches the expected identifier.",
      details: { expected: input.expected.identifier, actual: selectorFor(element) || stableReference(element) }
    };
  }
  if (!isCandidateVisible(element)) {
    return { ok: false, code: "candidate_not_visible", message: "Candidate is not visible.", details: { ref: input.ref || null } };
  }
  if (isDisabled(element)) {
    return { ok: false, code: "candidate_disabled", message: "Candidate is disabled.", details: { ref: input.ref || null } };
  }
  return { ok: true };
}

async function humanClick(element: Element | null, coordinate: [number, number] | undefined, settings: JsonObject): Promise<void> {
  const point = coordinate ? { x: coordinate[0], y: coordinate[1] } : centerOf(element);
  if (!point) throw new Error("Click requires a target element or coordinate.");
  const target = element || document.elementFromPoint(point.x, point.y);
  if (target instanceof HTMLElement) target.focus({ preventScroll: false });
  await delay(jitter(settings, 45));
  dispatchPointer(target || document.body, "pointermove", point);
  await delay(jitter(settings, 70));
  dispatchPointer(target || document.body, "pointerdown", point);
  dispatchMouse(target || document.body, "mousedown", point);
  await delay(jitter(settings, 85));
  dispatchPointer(target || document.body, "pointerup", point);
  dispatchMouse(target || document.body, "mouseup", point);
  dispatchMouse(target || document.body, "click", point);
  if (target instanceof HTMLElement) target.click();
}

async function humanType(element: Element | null, text: string, settings: JsonObject): Promise<void> {
  const target = editableTarget(element);
  target.focus({ preventScroll: false });
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    await delay(jitter(settings, 50));
    setNativeInputValue(target, text);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
  } else {
    for (const char of text) {
      document.execCommand("insertText", false, char);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: char, inputType: "insertText" }));
      await delay(randomBetween(numberSetting(settings, "typingMinDelayMs", 25), numberSetting(settings, "typingMaxDelayMs", 105)));
    }
  }
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

async function humanKey(element: Element | null, key: string, settings: JsonObject): Promise<void> {
  const target = (element instanceof HTMLElement ? element : document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  target.focus?.({ preventScroll: false });
  await delay(jitter(settings, 40));
  const down = target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await delay(jitter(settings, 55));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  if (down && key === "Enter" && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.form) {
    target.form.requestSubmit();
  }
}

async function humanScroll(element: Element | null, input: ComputerActionInput, settings: JsonObject): Promise<void> {
  const target = element || document.scrollingElement || document.documentElement;
  const direction = input.scroll_direction || input.direction || "down";
  const amount = input.amount ?? 520;
  const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
  for (let i = 0; i < 8; i += 1) {
    target.dispatchEvent(new WheelEvent("wheel", { deltaX: dx / 8, deltaY: dy / 8, bubbles: true, cancelable: true }));
    if ("scrollBy" in target) {
      (target as Element).scrollBy({ left: dx / 8, top: dy / 8, behavior: "auto" });
    } else {
      window.scrollBy({ left: dx / 8, top: dy / 8, behavior: "auto" });
    }
    await delay(jitter(settings, 35));
  }
}

async function humanDrag(element: Element | null, input: ComputerActionInput, settings: JsonObject): Promise<void> {
  const start = input.coordinate ? { x: input.coordinate[0], y: input.coordinate[1] } : centerOf(element);
  const end = input.to ? { x: input.to[0], y: input.to[1] } : start ? { x: start.x + 100, y: start.y } : null;
  if (!start || !end) throw new Error("Drag requires start and end coordinates.");
  const target = element || document.elementFromPoint(start.x, start.y) || document.body;
  dispatchPointer(target, "pointerdown", start);
  dispatchMouse(target, "mousedown", start);
  for (let i = 1; i <= 10; i += 1) {
    const point = { x: start.x + ((end.x - start.x) * i) / 10, y: start.y + ((end.y - start.y) * i) / 10 };
    dispatchPointer(target, "pointermove", point);
    dispatchMouse(target, "mousemove", point);
    await delay(jitter(settings, 24));
  }
  dispatchPointer(target, "pointerup", end);
  dispatchMouse(target, "mouseup", end);
}

function readableText(maxChars: number): string {
  const source = document.body || document.documentElement;
  const rawText = source && "innerText" in source && typeof (source as HTMLElement).innerText === "string"
    ? (source as HTMLElement).innerText
    : textContentWithoutNoise(source);
  const text = rawText.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  return text.slice(0, maxChars);
}

function describeActiveElement(tabId: number, frameId: number): JsonObject | undefined {
  const active = document.activeElement;
  if (!active) return undefined;
  return elementToCandidate(active, tabId, frameId, true)?.rawFields;
}

function isCandidateVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.01;
}

function isDisabled(element: Element): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

function isEditable(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return tag === "textarea" || tag === "input" || element.getAttribute("contenteditable") === "true";
}

function editableTarget(element: Element | null): HTMLElement {
  const target = element instanceof HTMLElement ? element : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!target || !isEditable(target)) throw new Error("Typing requires an editable target.");
  return target;
}

function setNativeInputValue(target: HTMLInputElement | HTMLTextAreaElement, insertedText: string): void {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  const nextValue = `${target.value.slice(0, start)}${insertedText}${target.value.slice(end)}`;
  const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(target, nextValue);
  if (!setter) target.value = nextValue;
  const cursor = start + insertedText.length;
  target.setSelectionRange(cursor, cursor);
}

function ariaRole(element: Element): string {
  return element.getAttribute("role") || implicitRole(element);
}

function implicitRole(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") return (element as HTMLInputElement).type === "checkbox" ? "checkbox" : "textbox";
  if (tag === "textarea") return "textbox";
  if (/^h[1-6]$/.test(tag)) return "heading";
  return tag;
}

function accessibleName(element: Element): string {
  const aria = element.getAttribute("aria-label") || element.getAttribute("title");
  if (aria) return truncate(aria.trim(), CANDIDATE_TEXT_MAX);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return truncate(labelledBy
      .split(/\s+/)
      .map((id) => textFor(document.getElementById(id)))
      .join(" ")
      .trim(), CANDIDATE_TEXT_MAX);
  }
  if (element instanceof HTMLInputElement && element.labels?.length) {
    return truncate(Array.from(element.labels).map((label) => textFor(label)).join(" ").trim(), CANDIDATE_TEXT_MAX);
  }
  return "";
}

function textFor(element: Element | null | undefined): string {
  if (!element) return "";
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return truncate(element.placeholder || element.value, CANDIDATE_TEXT_MAX);
  }
  if (["script", "style", "template", "noscript", "svg"].includes(element.tagName.toLowerCase())) return "";
  const text = "innerText" in element && typeof (element as HTMLElement).innerText === "string"
    ? (element as HTMLElement).innerText
    : textContentWithoutNoise(element);
  return truncate(text.replace(/\s+/g, " ").trim(), CANDIDATE_TEXT_MAX);
}

function textContentWithoutNoise(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const noisy of Array.from(clone.querySelectorAll("script,style,template,noscript,svg"))) {
    noisy.remove();
  }
  return clone.textContent || "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function valueFor(element: Element): string | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value || null;
  }
  return null;
}

function stableReference(element: Element): string {
  const durable = element.getAttribute("data-testid") || element.id || element.getAttribute("name") || element.getAttribute("aria-label");
  if (durable) return `dom:${hash(`${element.tagName}:${durable}`)}`;
  return `dom:${hash(`${selectorFor(element)}:${accessibleName(element)}:${textFor(element).slice(0, 120)}`)}`;
}

function selectorFor(element: Element): string | null {
  if (element.id) return `#${cssEscape(element.id)}`;
  const testId = element.getAttribute("data-testid");
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;
  const name = element.getAttribute("name");
  if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.tagName === current?.tagName) : [];
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = current.parentElement;
  }
  return parts.length ? parts.join(" > ") : null;
}

function xpathFor(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  return `/${parts.join("/")}`;
}

function rectToBounds(rect: DOMRect): Rect | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
}

function centerOf(element: Element | null): { x: number; y: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function elementFromCoordinate(coordinate?: [number, number]): Element | null {
  return coordinate ? document.elementFromPoint(coordinate[0], coordinate[1]) : null;
}

function dispatchPointer(target: Element, type: string, point: { x: number; y: number }): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, pointerId: 1, pointerType: "mouse", isPrimary: true }));
}

function dispatchMouse(target: Element, type: string, point: { x: number; y: number }): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button: 0 }));
}

function safeQueryAll(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function cssEscape(input: string): string {
  return input.replace(/["\\]/g, "\\$&");
}

function numberSetting(settings: JsonObject, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function jitter(settings: JsonObject, base: number): number {
  const spread = numberSetting(settings, "actionJitterMs", 60);
  return Math.max(0, base + randomBetween(-spread / 2, spread / 2));
}

function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
