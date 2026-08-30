export const RETINA_BROWSER_BRIDGE_KIND = "retina-browser-bridge" as const;
export const SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL =
  "source_chrome_mcp_compatibility" as const;
export const COMPATIBILITY_SERVER_NAME = "claude-in-chrome" as const;
export const NATIVE_HOST_ID = "com.retina.browser_bridge" as const;
export const NATIVE_HOST_MANIFEST = "com.retina.browser_bridge.json" as const;
export const NATIVE_HOST_DESCRIPTION = "Retina Browser Bridge Native Host" as const;
export const NATIVE_HOST_VERSION = "0.1.0" as const;
export const EXTENSION_ID = "lefpojfbfejboofinaodnoadplihdbhm" as const;
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6i74fY/HeOHi2XOXC4w0YSjerWSWr84M/Cumh5I2g90F1aZdOn6mYpqc3BzK57xr2cG6rl2BZulTeSErglNGg4Z4poMJSIT0D88B0vo/LJz2FD8faGFJIH5K1uS5pedMLVDDwEkvMA6HvCIB+o/F2nMEDoO9xRlLnkYoMW6WsB/BcM4cBALLC+h6Js6N5aKY+IDLwvmpUtWD7QR6VUGu7oWUq83ntZM2Y5nFC8leVxEkS/D9kzL+yXjXKllQiVp3bWBDzcGsOIwfgq6RlyNfTOLeitHnxRSGZiwLjUKwgVWTp4I+TJLH0mZVU1gDoLjaS/bVTyybsb9TyxJEdMK0UQIDAQAB" as const;
export const MAX_NATIVE_HOST_TO_CHROME_BYTES = 1024 * 1024;
export const MAX_CHROME_TO_NATIVE_HOST_BYTES = 64 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const SOCKET_DIR_PREFIX = "retina-browser-bridge";
export const STATUS_FILE_NAME = "status.json";

export const SOURCE_TOOL_NAMES = [
  "javascript_tool",
  "read_page",
  "find",
  "form_input",
  "computer",
  "navigate",
  "resize_window",
  "gif_creator",
  "upload_image",
  "get_page_text",
  "tabs_context_mcp",
  "tabs_create_mcp",
  "update_plan",
  "read_console_messages",
  "read_network_requests",
  "shortcuts_list",
  "shortcuts_execute"
] as const;

export const DEPLOYABLE_REQUIRED_CAPABILITIES = [
  "tab_context",
  "tab_create",
  "tab_focus",
  "page_read",
  "page_text",
  "element_discovery",
  "computer_action",
  "navigate",
  "console_read",
  "network_read",
  "installed_agent_host_access",
  "visible_user_control"
] as const;

export const PAGE_ACCESS_TOOLS = new Set([
  "javascript_tool",
  "read_page",
  "find",
  "form_input",
  "computer",
  "navigate",
  "resize_window",
  "gif_creator",
  "upload_image",
  "get_page_text",
  "tabs_create_mcp",
  "read_console_messages",
  "read_network_requests",
  "shortcuts_execute"
]);

export const VISIBLE_CONTROL_TOOLS = new Set([
  "javascript_tool",
  "form_input",
  "computer",
  "navigate",
  "resize_window",
  "gif_creator",
  "upload_image",
  "tabs_create_mcp",
  "shortcuts_execute"
]);

export const DEFAULT_SETTINGS = {
  controlEnabled: true,
  debuggerEnabled: true,
  redactLogs: true,
  actionJitterMs: 60,
  typingMinDelayMs: 25,
  typingMaxDelayMs: 105,
  maxPayloadBytes: MAX_NATIVE_HOST_TO_CHROME_BYTES - 8192
} as const;
