# Retina Browser Extension Bridge

Standalone MV3 browser extension and native host for Retina's source-compatible
`claude-in-chrome` browser automation lane.

## What Is Implemented

- Source-shaped `tool_request` / `tool_response` envelopes.
- MV3 service worker with a long-lived native messaging port.
- Native host with Chrome native-message framing and a local Retina-facing Unix
  socket.
- Popup user control with pause/resume, per-origin grant/revoke, debugger toggle,
  and host disconnect.
- Main-frame browser tools:
  - `tabs_context_mcp`
  - `tabs_create_mcp`
  - `read_page`
  - `get_page_text`
  - `find`
  - `computer`
  - `navigate`
  - `resize_window`
  - `form_input`
  - `javascript_tool` with debugger toggle
  - `read_console_messages` with debugger toggle
  - `read_network_requests` metadata with debugger toggle
  - `shortcuts_list`
- Human-paced browser actions for click, type, key, scroll, drag, and wait.
- Candidate pre-checks for stable refs, identifiers, visibility, and disabled
  state.
- Structured logging to stderr from the native host and service worker.
- Secret redaction for logs, console, and network payloads.

Deferred from the bridge plan: `gif_creator`, `upload_image`,
`shortcuts_execute`, and `update_plan` return explicit `unsupported` responses.

## Build

```sh
npm install
npm run build
npm test
```

The unpacked extension is written to:

```text
dist/extension
```

## Install For Local Testing

1. Build the project.
2. Open `chrome://extensions`, enable Developer Mode, and load
   `dist/extension` as an unpacked extension.
3. Install the native host manifest:

```sh
npm run install-host
```

For Brave, Edge, Chromium, or Chrome for Testing:

```sh
npm run install-host -- --browser brave
```

The installer writes a wrapper script under `~/.retina/browser-bridge/` and a
browser native-host manifest named `com.retina.browser_bridge.json`.
The unpacked extension has a fixed development id:

```text
lefpojfbfejboofinaodnoadplihdbhm
```

If Chrome shows a different id for an already-loaded unpacked copy, install the
native host for that id too:

```sh
npm run install-host -- --extension-id <chrome-shown-id>
```

## Local Socket

When Chrome starts the native host, it writes status to:

```text
~/.retina/browser-bridge/status.json
```

Retina or a test client can read `socketPath` from that file and send
length-prefixed JSON tool requests using the same 32-bit little-endian framing as
Chrome native messaging.

## Open Decisions Answered

- Native messaging first. Current Chrome docs keep `runtime.connectNative()` as
  the long-lived channel and cap host-to-Chrome messages at 1 MB, which matches
  the Retina plan.
- Popup first. The first visible control surface is a popup, with room to add a
  side panel after mutating actions are field-tested.
- No `webextension-polyfill` yet. The first target is Chromium-family browsers,
  so direct `chrome.*` APIs keep the runtime smaller.
- Debugger tooling is runtime opt-in from the popup, but Chrome requires the
  `debugger` manifest permission to be listed as a normal permission rather than
  an optional permission.
- Session-owned tabs by default. The service worker records `sessionId` ownership
  when provided and rejects cross-session mutation.

## Research References

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Chrome permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
