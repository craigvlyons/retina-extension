import type {
  COMPATIBILITY_SERVER_NAME,
  RETINA_BROWSER_BRIDGE_KIND,
  SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL,
  SOURCE_TOOL_NAMES
} from "./constants";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type SourceToolName = (typeof SOURCE_TOOL_NAMES)[number];

export type TextContent = { type: "text"; text: string };

export type ToolRequest = {
  type: "tool_request";
  method: SourceToolName | string;
  params?: JsonObject;
  requestId?: string;
  compatibilityServerName?: typeof COMPATIBILITY_SERVER_NAME | string;
  bridgeKind?: typeof RETINA_BROWSER_BRIDGE_KIND | string;
  protocol?: typeof SOURCE_CHROME_MCP_COMPATIBILITY_PROTOCOL | string;
};

export type ToolResponseStatus =
  | "ok"
  | "error"
  | "permission_required"
  | "unsupported"
  | "timeout"
  | "stale_candidate"
  | "tab_not_found"
  | "frame_not_found"
  | "bridge_disconnected";

export type BridgeError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonObject;
};

export type ToolResponse = {
  v?: 1;
  id?: string;
  type: "tool_response";
  requestId: string;
  method: string;
  status?: ToolResponseStatus;
  isError: boolean;
  content: TextContent[];
  structuredContent?: JsonObject;
  error?: BridgeError | null;
  meta?: JsonObject;
};

export type RuntimeEnvelope = {
  v: 1;
  id: string;
  type: "tool_request";
  source: "retina-runtime" | "native-host" | string;
  sessionId?: string;
  requestId: string;
  tabId?: number;
  frameId?: number;
  method: string;
  params: JsonObject;
  compatibility: {
    serverName: string;
    bridgeKind: string;
    protocol: string;
  };
  site?: {
    origin: string;
    permissionState: PermissionStateName;
  };
  meta?: {
    timeoutMs?: number;
    toolUseId?: string;
  };
};

export type PermissionStateName = "granted" | "withheld" | "unknown" | "blocked";

export type GeometryState = "known" | "estimated" | "missing" | "stale";
export type ActionCapability =
  | "browser_click"
  | "pixel_click"
  | "type"
  | "press"
  | "scroll"
  | "drag"
  | "set_value";

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export type BrowserCandidate = {
  id: string;
  source: "browser";
  role?: string | null;
  displayName: string;
  value?: string | null;
  identifier?: string | null;
  stableRef?: string | null;
  bounds?: Rect | null;
  center?: Point | null;
  geometryState: GeometryState;
  actionCapabilities: ActionCapability[];
  rawFields: JsonObject;
};

export type BrowserTabRecord = {
  id: string;
  tabId: number;
  windowId?: number;
  title?: string;
  url?: string;
  active?: boolean;
  focused?: boolean;
  status?: string;
  permissionState: PermissionStateName;
  ownedBySessionId?: string;
};

export type ObservationEvent = {
  v: 1;
  type: "event";
  event: "observation";
  sessionId?: string;
  tabId?: number;
  frameId?: number;
  severity: "debug" | "info" | "warn" | "error";
  category:
    | "bridge_status"
    | "permission"
    | "tab_context"
    | "page_read"
    | "candidate_discovery"
    | "candidate_validation"
    | "browser_action"
    | "console"
    | "network"
    | "error";
  message: string;
  data?: JsonObject;
};

export type ComputerActionInput = {
  action: "left_click" | "type" | "key" | "scroll" | "left_click_drag" | "wait" | string;
  tabId?: number;
  frameId?: number;
  candidateId?: string;
  coordinate?: [number, number];
  ref?: string;
  text?: string | null;
  key?: string | null;
  scroll_direction?: string;
  direction?: string;
  amount?: number;
  to?: [number, number];
  expected?: {
    stableRef?: string;
    identifier?: string;
  };
};

export type ExtensionSettings = {
  controlEnabled: boolean;
  debuggerEnabled: boolean;
  redactLogs: boolean;
  actionJitterMs: number;
  typingMinDelayMs: number;
  typingMaxDelayMs: number;
  maxPayloadBytes: number;
};

export type PopupState = {
  nativeConnected: boolean;
  controlEnabled: boolean;
  debuggerEnabled: boolean;
  activeTab?: BrowserTabRecord;
  lastAction?: string;
  lastError?: string;
  sessions: string[];
};

