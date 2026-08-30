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

  // Retina's opaque candidate handle resolves privately to an expected stable
  // reference. Prefer that identity over a structural selector, which may be
  // non-unique on dense pages with repeated forms. If the stable reference is
  // stale, fail closed instead of silently falling back to another match.
  const target = input.expected?.stableRef || input.ref || input.candidateId || input.expected?.identifier;
  const element = target ? resolveElement(target) : elementFromCoordinate(input.coordinate);
  if (!element && input.action !== "scroll" && input.action !== "key" && !input.coordinate) {
    return {
      ok: false,
      code: "stale_candidate",
      message: "The requested browser candidate is no longer available.",
      details: { ref: target || null }
    };
  }

  const beforeEditableValue = element && (input.action === "type" || input.action === "set_value" || input.action === "select") ? editableValue(element) : null;

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
    case "set_value":
      await replaceEditableValue(element, input.text ?? "", settings);
      break;
    case "select": {
      const selectResult = selectValue(element, input.text ?? "");
      if (!selectResult.ok) return selectResult;
      break;
    }
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

  if (element && (input.action === "type" || input.action === "set_value" || input.action === "select")) {
    const settleMs = Math.min(500, Math.max(50, numberSetting(settings, "postActionSettleMs", 150)));
    await delay(settleMs);
    const typeValidation = validateTypedValue(element, input, beforeEditableValue);
    if (!typeValidation.ok) return typeValidation;
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
  for (const root of queryRoots()) {
    for (const element of Array.from(root.querySelectorAll(interactiveSelector))) {
      if (includeHidden || isCandidateVisible(element)) elements.add(element);
    }
    for (const heading of Array.from(root.querySelectorAll("h1,h2,h3,label,[aria-live]"))) {
      if (includeHidden || isCandidateVisible(heading)) elements.add(heading);
    }
  }
  return Array.from(elements);
}

function queryRoots(): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    if (!root) continue;
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
    }
  }
  return roots;
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
  const accessible = accessibleNameWithProvenance(element);
  const displayFallback = isEditable(element) ? editableDisplayFallback(element) : rawText;
  const displayName = truncate(accessible.name || displayFallback || role || element.tagName.toLowerCase(), CANDIDATE_TEXT_MAX);
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
      chromeFrameId: frameId,
      framePath: shadowPath(element),
      url: location.href,
      cssSelector: selectorFor(element),
      xpath: xpathFor(element),
      ariaRole: role,
      accessibleName: accessible.name || null,
      accessibleNameSource: accessible.source,
      accessibleNameTrusted: accessible.trusted,
      semanticAncestry: semanticAncestry(element),
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
  if (
    ["button", "a", "summary", "option", "select"].includes(tag) ||
    ["button", "link", "checkbox", "radio", "switch", "tab", "option", "combobox", "listbox", "menuitem"].includes(role) ||
    element.hasAttribute("onclick")
  ) {
    caps.push("browser_click");
  }
  if (isTextEditable(element)) caps.push("type", "set_value");
  else if (supportsSetValue(element)) caps.push("set_value");
  if (isKeyboardActionTarget(element, role)) caps.push("press");
  if (isScrollable(element, role)) caps.push("scroll");
  if (isDraggable(element, role)) caps.push("drag");
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
  if (input.coordinate) {
    const [x, y] = input.coordinate;
    const rect = element.getBoundingClientRect();
    const bounds = rectToBounds(rect);
    const tolerance = 2;
    if (!bounds || x < bounds.x - tolerance || x > bounds.x + bounds.width + tolerance || y < bounds.y - tolerance || y > bounds.y + bounds.height + tolerance) {
      return {
        ok: false,
        code: "coordinate_mismatch",
        message: "Click coordinate is outside the expected candidate bounds.",
        details: { coordinate: input.coordinate, bounds, ref: input.ref || null }
      };
    }
    const viewportPoint = toViewportPoint({ x, y });
    const hit = document.elementFromPoint(viewportPoint.x, viewportPoint.y);
    if (hit && hit !== element && !element.contains(hit)) {
      return {
        ok: false,
        code: "coordinate_mismatch",
        message: "Click coordinate resolves to a different page element.",
        details: {
          coordinate: input.coordinate,
          expected: stableReference(element),
          actual: stableReference(hit)
        }
      };
    }
  }
  return { ok: true };
}

function validateTypedValue(
  element: Element,
  input: ComputerActionInput,
  beforeValue: string | null
): ContentResponse | { ok: true } {
  const afterValue = editableValue(element);
  if (afterValue === null) {
    return {
      ok: false,
      code: "type_target_not_editable",
      message: "Typing target is no longer editable after dispatch.",
      details: { ref: input.ref || null }
    };
  }
  const expectedValue = input.expected?.value ?? input.expected?.text;
  const selectedOption = element instanceof HTMLSelectElement ? element.selectedOptions[0] : null;
  const expectedMatchesSelection = selectedOption && expectedValue !== undefined
    ? [selectedOption.value, selectedOption.label, selectedOption.text].some((value) => value === expectedValue)
    : false;
  if (expectedValue !== undefined && afterValue !== expectedValue && !expectedMatchesSelection) {
    return {
      ok: false,
      code: "type_value_mismatch",
      message: "Typed value did not match the expected value.",
      details: {
        expectedLength: expectedValue.length,
        actualLength: afterValue.length,
        changed: beforeValue !== afterValue
      }
    };
  }
  if (expectedValue === undefined && input.text && beforeValue === afterValue) {
    return {
      ok: false,
      code: "type_no_change",
      message: "Typing dispatched but the editable value did not change.",
      details: { textLength: input.text.length, changed: false }
    };
  }
  return { ok: true };
}

async function humanClick(element: Element | null, coordinate: [number, number] | undefined, settings: JsonObject): Promise<void> {
  const point = coordinate ? toViewportPoint({ x: coordinate[0], y: coordinate[1] }) : centerOf(element);
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
  // HTMLElement.click() runs the element's activation behavior, including form
  // validation/submission for submit controls. Dispatching a separate synthetic
  // click first activates the same control twice and can race framework-managed
  // forms. Non-HTML SVG controls do not expose click(), so dispatch once there.
  if (target instanceof HTMLElement) target.click();
  else dispatchMouse(target || document.body, "click", point);
}

function selectValue(element: Element | null, requestedValue: string): ContentResponse | { ok: true } {
  if (!(element instanceof HTMLSelectElement)) {
    return {
      ok: false,
      code: "select_target_not_selectable",
      message: "Selecting a value requires a select control.",
      details: { value: requestedValue }
    };
  }
  const normalized = requestedValue.trim().toLocaleLowerCase();
  const options = Array.from(element.options);
  const option = options.find((candidate) =>
    candidate.value === requestedValue || candidate.label === requestedValue || candidate.text === requestedValue
  ) || options.find((candidate) =>
    [candidate.value, candidate.label, candidate.text].some((value) => value.trim().toLocaleLowerCase() === normalized)
  );
  if (!option) {
    return {
      ok: false,
      code: "invalid_select_value",
      message: "The requested option is not available in this select control.",
      details: {
        value: requestedValue,
        options: options.slice(0, 50).map((candidate) => candidate.label || candidate.text || candidate.value)
      }
    };
  }
  element.focus({ preventScroll: false });
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
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

async function replaceEditableValue(element: Element | null, text: string, settings: JsonObject): Promise<void> {
  const target = editableTarget(element);
  target.focus({ preventScroll: false });
  await delay(jitter(settings, 50));
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(target, text);
    if (!setter) target.value = text;
  } else {
    target.textContent = text;
  }
  target.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    data: text,
    inputType: "insertReplacementText"
  }));
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
  const start = input.coordinate ? toViewportPoint({ x: input.coordinate[0], y: input.coordinate[1] }) : centerOf(element);
  const end = input.to ? toViewportPoint({ x: input.to[0], y: input.to[1] }) : start ? { x: start.x + 100, y: start.y } : null;
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
  return isTextEditable(element);
}

function isTextEditable(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLElement && element.getAttribute("contenteditable") === "true") return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit"
  ].includes(element.type);
}

function supportsSetValue(element: Element): boolean {
  if (isTextEditable(element) || element instanceof HTMLSelectElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return ["color", "date", "datetime-local", "month", "range", "time", "week"].includes(element.type);
}

function isKeyboardActionTarget(element: Element, role: string): boolean {
  if (isTextEditable(element) || supportsSetValue(element)) return true;
  if (element instanceof HTMLButtonElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) return true;
  if (element instanceof HTMLInputElement) return element.type !== "hidden";
  if (element instanceof HTMLElement && element.tabIndex >= 0) return true;
  return ["button", "link", "checkbox", "radio", "switch", "tab", "option", "combobox", "listbox", "menuitem", "slider", "spinbutton"].includes(role);
}

function isScrollable(element: Element, role: string): boolean {
  if (["document", "webarea", "main", "feed"].includes(role)) return true;
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
  return /(auto|scroll)/.test(overflow) && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth);
}

function isDraggable(element: Element, role: string): boolean {
  if (element instanceof HTMLInputElement && element.type === "range") return true;
  return element.getAttribute("draggable") === "true" || role === "slider";
}

function editableTarget(element: Element | null): HTMLElement {
  const target = element instanceof HTMLElement ? element : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!target || !isEditable(target)) throw new Error("Typing requires an editable target.");
  return target;
}

function editableValue(element: Element): string | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value;
  }
  if (element instanceof HTMLElement && element.getAttribute("contenteditable") === "true") {
    return element.innerText;
  }
  return null;
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
  try {
    target.setSelectionRange(cursor, cursor);
  } catch {
    // Number/date/color and other non-text input types do not expose a
    // selection range. The insertion itself still completed.
  }
}

function ariaRole(element: Element): string {
  return element.getAttribute("role") || implicitRole(element);
}

function implicitRole(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") {
    const input = element as HTMLInputElement;
    if (["button", "image", "reset", "submit"].includes(input.type)) return "button";
    if (input.type === "checkbox") return "checkbox";
    if (input.type === "radio") return "radio";
    if (input.type === "range") return "slider";
    if (input.type === "number") return "spinbutton";
    if (input.type === "search") return input.hasAttribute("list") ? "combobox" : "searchbox";
    if (["email", "tel", "text", "url"].includes(input.type) && input.hasAttribute("list")) return "combobox";
    return "textbox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return (element as HTMLSelectElement).multiple || (element as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
  if (/^h[1-6]$/.test(tag)) return "heading";
  return tag;
}

type AccessibleNameProvenance = {
  name: string;
  source: "aria_label" | "aria_labelledby" | "html_label" | "title" | "none";
  trusted: boolean;
};

function accessibleNameWithProvenance(element: Element): AccessibleNameProvenance {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel?.trim()) {
    return {
      name: truncate(ariaLabel.trim(), CANDIDATE_TEXT_MAX),
      source: "aria_label",
      trusted: true
    };
  }
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const name = truncate(labelledBy
      .split(/\s+/)
      .map((id) => staticLabelText(document.getElementById(id)))
      .join(" ")
      .trim(), CANDIDATE_TEXT_MAX);
    if (name) return { name, source: "aria_labelledby", trusted: true };
  }
  if (element instanceof HTMLInputElement && element.labels?.length) {
    const name = truncate(
      Array.from(element.labels).map((label) => staticLabelText(label)).join(" ").trim(),
      CANDIDATE_TEXT_MAX
    );
    if (name) return { name, source: "html_label", trusted: true };
  }
  const title = element.getAttribute("title");
  if (title?.trim()) {
    return {
      name: truncate(title.trim(), CANDIDATE_TEXT_MAX),
      source: "title",
      trusted: true
    };
  }
  return { name: "", source: "none", trusted: false };
}

function accessibleName(element: Element): string {
  return accessibleNameWithProvenance(element).name;
}

function staticLabelText(element: Element | null | undefined): string {
  if (!element) return "";
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return "";
  }
  return textFor(element);
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
  const durable = element.getAttribute("data-retina-ref") || element.getAttribute("data-testid") || element.id || element.getAttribute("name") || element.getAttribute("aria-label");
  if (durable) return `dom:${hash(`${element.tagName}:${durable}`)}`;
  const stableText = isEditable(element) ? editableDisplayFallback(element) : textFor(element).slice(0, 120);
  return `dom:${hash(`${selectorFor(element)}:${accessibleName(element)}:${stableText}`)}`;
}

function editableDisplayFallback(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return truncate(element.placeholder.trim(), CANDIDATE_TEXT_MAX);
  }
  return "";
}

function selectorFor(element: Element): string | null {
  if (element.id) return `#${cssEscape(element.id)}`;
  const retinaRef = element.getAttribute("data-retina-ref");
  if (retinaRef) return `[data-retina-ref="${cssEscape(retinaRef)}"]`;
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

function shadowPath(element: Element): string | null {
  const parts: string[] = [];
  let root = element.getRootNode();
  while (root instanceof ShadowRoot) {
    const host = root.host;
    parts.unshift(`${selectorFor(host) || host.tagName.toLowerCase()}#shadow`);
    root = host.getRootNode();
  }
  return parts.length ? parts.join("/") : null;
}

function semanticAncestry(element: Element): string[] {
  const ancestry: string[] = [];
  let current = semanticParent(element);
  while (current && ancestry.length < 12) {
    const descriptor = semanticAncestorDescriptor(current);
    if (descriptor) ancestry.unshift(descriptor);
    current = semanticParent(current);
  }
  return ancestry;
}

function semanticParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function semanticAncestorDescriptor(element: Element): string | null {
  const role = ariaRole(element);
  const semanticRole = ["div", "span", "section", "body", "html"].includes(role)
    ? (element.getAttribute("role") || "")
    : role;
  const explicitName = safeAncestorText(accessibleName(element));
  const heading = Array.from(element.children)
    .find((child) => /^h[1-6]$/i.test(child.tagName)) as Element | undefined;
  const headingText = safeAncestorText(heading ? textFor(heading) : "");
  const name = [explicitName, headingText]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(" — ");
  if (!semanticRole && !name) return null;
  const normalizedRole = safeAncestorText(semanticRole || "group") || "group";
  return truncate(name ? `[${normalizedRole}] ${name}` : `[${normalizedRole}]`, 192);
}

function safeAncestorText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || /https?:\/\/|[A-Za-z]:\\|\\|@/.test(normalized)) return "";
  return truncate(normalized, 160);
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

function toViewportPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.x - window.scrollX, y: point.y - window.scrollY };
}

function centerOf(element: Element | null): { x: number; y: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function elementFromCoordinate(coordinate?: [number, number]): Element | null {
  if (!coordinate) return null;
  const point = toViewportPoint({ x: coordinate[0], y: coordinate[1] });
  return document.elementFromPoint(point.x, point.y);
}

function dispatchPointer(target: Element, type: string, point: { x: number; y: number }): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, pointerId: 1, pointerType: "mouse", isPrimary: true }));
}

function dispatchMouse(target: Element, type: string, point: { x: number; y: number }): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button: 0 }));
}

function safeQueryAll(selector: string): Element[] {
  try {
    return queryRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
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
