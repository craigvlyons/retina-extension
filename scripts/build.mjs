import esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { publishExtensionArtifact, RETINA_EXTENSION_ID } from "./extension-artifact.mjs";
import {
  EXTENSION_DISTRIBUTION_FILE,
  createExtensionDistribution
} from "./extension-distribution.mjs";

const root = process.cwd();
const dist = path.join(root, "dist");
const extensionDist = path.join(dist, "extension");
const nativeDist = path.join(dist, "native");
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const buildMode = process.env.RETINA_EXTENSION_BUILD === "production" || process.argv.includes("--prod") || process.argv.includes("--production")
  ? "production"
  : "development";

if (typeof packageMetadata.version !== "string" || packageMetadata.version.trim() === "") {
  throw new Error("package.json must contain a non-empty extension version");
}
await rm(extensionDist, { recursive: true, force: true });
await rm(nativeDist, { recursive: true, force: true });
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
const browserManifest = await manifestForBuild();
if (browserManifest.version !== packageMetadata.version) {
  throw new Error(
    `Extension version mismatch: package.json=${packageMetadata.version}, manifest.json=${browserManifest.version}`
  );
}
await writeFile(path.join(extensionDist, "manifest.json"), `${JSON.stringify(browserManifest, null, 2)}\n`);
await writeFile(
  path.join(extensionDist, EXTENSION_DISTRIBUTION_FILE),
  `${JSON.stringify(createExtensionDistribution({
    extensionId: RETINA_EXTENSION_ID,
    extensionVersion: packageMetadata.version
  }), null, 2)}\n`
);

if (existsSync("public/icons")) {
  await cp("public/icons", path.join(extensionDist, "icons"), { recursive: true });
}

if (buildMode === "production") {
  const artifactDirectory = path.join(
    dist,
    "artifacts",
    "retina-extension",
    packageMetadata.version
  );
  const artifactManifest = await publishExtensionArtifact({
    sourceDirectory: extensionDist,
    artifactDirectory
  });
  console.log(
    `Published Retina extension ${artifactManifest.extension_version} `
    + `(${artifactManifest.extension_id}) to ${artifactDirectory}`
  );
}

for (const file of ["host.js", "install_host.js"]) {
  const target = path.join(nativeDist, file);
  const current = await readFile(target, "utf8");
  await writeFile(target, current, { mode: 0o755 });
}

async function manifestForBuild() {
  const manifest = JSON.parse(await readFile(path.join("public", "manifest.json"), "utf8"));
  const broadHostPermissions = ["<all_urls>"];
  manifest.host_permissions = manifest.host_permissions || broadHostPermissions;
  delete manifest.optional_host_permissions;
  if (buildMode === "development") {
    manifest.description = `${manifest.description} Development build.`;
  }
  return manifest;
}
