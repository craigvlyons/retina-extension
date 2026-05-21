#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  NATIVE_HOST_DESCRIPTION,
  NATIVE_HOST_ID,
  NATIVE_HOST_MANIFEST
} from "../shared/constants";

type Browser = "chrome" | "chrome_for_testing" | "chromium" | "brave" | "edge";

const args = new Map<string, string | boolean>();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]!;
  if (arg.startsWith("--")) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(arg.slice(2), next);
      i += 1;
    } else {
      args.set(arg.slice(2), true);
    }
  }
}

const extensionId = String(args.get("extension-id") || "");
if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error("Usage: retina-browser-bridge-install-host --extension-id <32-char chrome extension id> [--browser chrome|brave|edge|chromium|chrome_for_testing]");
  process.exit(2);
}

const browser = String(args.get("browser") || "chrome") as Browser;
const hostPath = path.resolve(String(args.get("host-path") || path.join(process.cwd(), "dist", "native", "host.js")));
const manifestPath = nativeMessagingManifestPath(browser);
const wrapperPath = wrapperScriptPath();
const manifest = {
  name: NATIVE_HOST_ID,
  description: NATIVE_HOST_DESCRIPTION,
  path: wrapperPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`]
};

await mkdir(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
await writeFile(wrapperPath, wrapperContent(hostPath), { mode: 0o755 });
await chmod(wrapperPath, 0o755).catch(() => undefined);
await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

console.log(JSON.stringify({ ok: true, browser, manifestPath, wrapperPath, hostPath, manifest }, null, 2));

function wrapperContent(host: string): string {
  if (platform() === "win32") {
    return `@echo off\r\nnode "${host}"\r\n`;
  }
  return `#!/bin/sh\nexec node "${host}"\n`;
}

function wrapperScriptPath(): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA || homedir();
    return path.join(appData, "Retina", "BrowserNativeHost", "retina-browser-bridge-host.bat");
  }
  return path.join(homedir(), ".retina", "browser-bridge", "retina-browser-bridge-host");
}

function nativeMessagingManifestPath(browser: Browser): string {
  if (platform() === "darwin") {
    const baseByBrowser: Record<Browser, string> = {
      chrome: path.join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      chrome_for_testing: path.join(homedir(), "Library", "Application Support", "Google", "ChromeForTesting", "NativeMessagingHosts"),
      chromium: path.join(homedir(), "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
      brave: path.join(homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      edge: path.join(homedir(), "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts")
    };
    return path.join(baseByBrowser[browser], NATIVE_HOST_MANIFEST);
  }
  if (platform() === "linux") {
    const baseByBrowser: Record<Browser, string> = {
      chrome: path.join(homedir(), ".config", "google-chrome", "NativeMessagingHosts"),
      chrome_for_testing: path.join(homedir(), ".config", "google-chrome-for-testing", "NativeMessagingHosts"),
      chromium: path.join(homedir(), ".config", "chromium", "NativeMessagingHosts"),
      brave: path.join(homedir(), ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      edge: path.join(homedir(), ".config", "microsoft-edge", "NativeMessagingHosts")
    };
    return path.join(baseByBrowser[browser], NATIVE_HOST_MANIFEST);
  }
  if (platform() === "win32") {
    const appData = process.env.APPDATA || homedir();
    return path.join(appData, "Retina", "BrowserNativeHost", NATIVE_HOST_MANIFEST);
  }
  throw new Error(`Unsupported platform: ${platform()}`);
}

