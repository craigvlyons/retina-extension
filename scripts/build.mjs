import esbuild from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const extensionDist = path.join(dist, "extension");
const nativeDist = path.join(dist, "native");
const buildMode = process.env.RETINA_EXTENSION_BUILD === "production" || process.argv.includes("--prod") || process.argv.includes("--production")
  ? "production"
  : "development";

await mkdir(extensionDist, { recursive: true });
await mkdir(nativeDist, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  target: "es2022",
  logLevel: "info"
};

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: ["src/extension/service_worker.ts"],
    outfile: "dist/extension/service_worker.js",
    format: "esm",
    platform: "browser"
  }),
  esbuild.build({
    ...common,
    entryPoints: ["src/extension/content_script.ts"],
    outfile: "dist/extension/content_script.js",
    format: "iife",
    platform: "browser"
  }),
  esbuild.build({
    ...common,
    entryPoints: ["src/extension/popup.ts"],
    outfile: "dist/extension/popup.js",
    format: "iife",
    platform: "browser"
  }),
  esbuild.build({
    ...common,
    entryPoints: ["src/native/host.ts"],
    outfile: "dist/native/host.js",
    format: "esm",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" }
  }),
  esbuild.build({
    ...common,
    entryPoints: ["src/native/install_host.ts"],
    outfile: "dist/native/install_host.js",
    format: "esm",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" }
  })
]);

for (const file of ["popup.html", "popup.css"]) {
  await cp(path.join("public", file), path.join(extensionDist, file));
}
await writeFile(path.join(extensionDist, "manifest.json"), `${JSON.stringify(await manifestForBuild(), null, 2)}\n`);

if (existsSync("public/icons")) {
  await cp("public/icons", path.join(extensionDist, "icons"), { recursive: true });
}

for (const file of ["host.js", "install_host.js"]) {
  const target = path.join(nativeDist, file);
  const current = await readFile(target, "utf8");
  await writeFile(target, current, { mode: 0o755 });
}

async function manifestForBuild() {
  const manifest = JSON.parse(await readFile(path.join("public", "manifest.json"), "utf8"));
  const broadHostPermissions = ["http://*/*", "https://*/*"];
  if (buildMode === "development") {
    manifest.host_permissions = broadHostPermissions;
    delete manifest.optional_host_permissions;
    manifest.description = `${manifest.description} Development build with broad local smoke-test host access.`;
  } else {
    manifest.optional_host_permissions = manifest.optional_host_permissions || broadHostPermissions;
    delete manifest.host_permissions;
  }
  return manifest;
}
