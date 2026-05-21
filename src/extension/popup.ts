import type { PopupState } from "../shared/types";

const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const tabEl = document.querySelector<HTMLDivElement>("#tab")!;
const controlToggle = document.querySelector<HTMLInputElement>("#controlEnabled")!;
const debuggerToggle = document.querySelector<HTMLInputElement>("#debuggerEnabled")!;
const grantButton = document.querySelector<HTMLButtonElement>("#grantOrigin")!;
const revokeButton = document.querySelector<HTMLButtonElement>("#revokeOrigin")!;
const disconnectButton = document.querySelector<HTMLButtonElement>("#disconnect")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;

void refresh();

controlToggle.addEventListener("change", () => send({ type: "retina_toggle_control", enabled: controlToggle.checked }));
debuggerToggle.addEventListener("change", () => send({ type: "retina_toggle_debugger", enabled: debuggerToggle.checked }));
grantButton.addEventListener("click", () => send({ type: "retina_grant_origin" }));
revokeButton.addEventListener("click", () => send({ type: "retina_revoke_origin" }));
disconnectButton.addEventListener("click", () => send({ type: "retina_disconnect_native" }));
refreshButton.addEventListener("click", () => refresh());

async function send(message: Record<string, unknown>): Promise<void> {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.state) render(response.state);
  else await refresh();
}

async function refresh(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: "retina_popup_state" });
  if (response?.state) render(response.state);
}

function render(state: PopupState): void {
  controlToggle.checked = state.controlEnabled;
  debuggerToggle.checked = state.debuggerEnabled;
  const native = state.nativeConnected ? "Native host connected" : "Native host disconnected";
  const control = state.controlEnabled ? "control enabled" : "control paused";
  statusEl.textContent = `${native}; ${control}`;
  if (state.activeTab) {
    const permission = state.activeTab.permissionState;
    tabEl.textContent = `${state.activeTab.title || "Untitled"}\n${state.activeTab.url || ""}\nPermission: ${permission}`;
    grantButton.disabled = permission === "granted" || permission === "blocked";
    revokeButton.disabled = permission !== "granted";
  } else {
    tabEl.textContent = "No active tab.";
    grantButton.disabled = true;
    revokeButton.disabled = true;
  }
}

