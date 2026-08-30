# Retina Browser Extension Bridge

Standalone MV3 browser extension and native host for Retina's source-compatible
`claude-in-chrome` browser automation lane.

## What Is Implemented

- Source-shaped `tool_request` / `tool_response` envelopes.
- MV3 service worker with a long-lived native messaging port.
- Native host with Chrome native-message framing and a local Retina-facing Unix
  socket.
- Popup user control with pause/resume, debugger toggle, and host disconnect.
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
npm run build:prod
npm test
```

The unpacked extension is written to:

```text
dist/extension
```

`npm run build:prod` also publishes the versioned, consumer-ready artifact to:

```text
dist/artifacts/retina-extension/<package-version>
```

For version `0.1.3`, the promoted directory is
`dist/artifacts/retina-extension/0.1.3`. It contains the production
`manifest.json`, all extension assets, `extension-distribution.json`, and
`extension-artifact-manifest.json`. The distribution contract is generated from
`package.json`, declares the fixed extension ID
`lefpojfbfejboofinaodnoadplihdbhm`, and describes the supported browser loading
channel and machine-readable next actions. The artifact manifest declares the
matching extension version and ID, points at that distribution contract, and
contains a deterministic SHA-256 inventory of every other regular file. The
inventory excludes only
`extension-artifact-manifest.json` because a file cannot contain its own stable
hash. Publication and validation reject symbolic links, path escapes, duplicate
entries, unlisted files, stale hashes, and manifest identity/version mismatch.

Validate the default published artifact independently with:

```sh
npm run validate:artifact
```

Or validate an explicitly promoted directory:

```sh
npm run validate:artifact -- C:\artifacts\retina-extension\0.1.3
```

Newly published artifacts require and inventory the distribution contract.
Previously promoted immutable artifacts remain independently verifiable, but do
not retroactively acquire the contract.

Both development and production manifests grant `<all_urls>` host access when
the user installs/enables Retina. Installation is the browser-access consent
boundary; the agent does not interrupt work with per-origin permission prompts.

## Extension Distribution

The currently supported release channel is explicit manual unpacked loading from
the immutable versioned artifact directory. Chrome and Edge do not allow Retina
or Gabanode to silently install an unpacked extension into a regular user
profile. There is no published Chrome Web Store URL, Edge Add-ons URL, or signed
enterprise-policy artifact yet, and the distribution contract deliberately
reports each of those channels as unavailable instead of inventing one.

For Chrome:

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the immutable artifact root containing `manifest.json`.
5. Verify extension ID `lefpojfbfejboofinaodnoadplihdbhm`.

For Edge, follow the same sequence at `edge://extensions/`.

`extension-distribution.json` exposes these ordered action codes, exact setup
URLs, channel availability, and the `statusContract` state-to-next-action map for
Retina, terminal clients, desktop shells, and future UIs. See
[`docs/extension-distribution.md`](docs/extension-distribution.md) for the stable
contract and promotion rules.

## Install For Local Testing

1. Build the project.
2. Open `chrome://extensions/`, enable Developer Mode, and load
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

## Smoke Tests

List open tabs and verify the native bridge socket:

```sh
npm run smoke
```

Run the deterministic local form flow after Chrome has the unpacked development
build loaded:

```sh
npm run smoke:form
```

That script serves `test/fixtures/form-smoke.html`, creates a tab, types into a
form, submits it with Enter, clicks a link, and waits for navigation to settle.

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
- Development and production builds declare `<all_urls>` host permission. Retina
  is an installed automation agent, so extension installation
  grants browser access up front; the popup's Browser control toggle remains the
  immediate user pause/resume boundary.
- Session-owned tabs by default. The service worker records `sessionId` ownership
  when provided and rejects cross-session mutation.

## Research References

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Chrome permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
