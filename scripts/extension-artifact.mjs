import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EXTENSION_DISTRIBUTION_FILE,
  validateExtensionDistribution
} from "./extension-distribution.mjs";

export const EXTENSION_ARTIFACT_MANIFEST = "extension-artifact-manifest.json";
export const RETINA_EXTENSION_ID = "lefpojfbfejboofinaodnoadplihdbhm";

export function deriveChromeExtensionId(publicKey) {
  if (typeof publicKey !== "string" || publicKey.trim() === "") {
    throw new Error("manifest.json must contain a non-empty extension public key");
  }
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/[0-9a-f]/g, (nibble) => "abcdefghijklmnop"[Number.parseInt(nibble, 16)]);
}

export async function publishExtensionArtifact({ sourceDirectory, artifactDirectory }) {
  const sourceRoot = path.resolve(sourceDirectory);
  const artifactRoot = path.resolve(artifactDirectory);
  if (sourceRoot === artifactRoot || artifactRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error("Extension artifact directory must not be inside the source directory");
  }

  const sourceFiles = await listRegularFiles(sourceRoot, {
    excluded: new Set([EXTENSION_ARTIFACT_MANIFEST])
  });
  if (!sourceFiles.includes("manifest.json")) {
    throw new Error("Production extension output is missing manifest.json");
  }
  if (!sourceFiles.includes(EXTENSION_DISTRIBUTION_FILE)) {
    throw new Error(`Production extension output is missing ${EXTENSION_DISTRIBUTION_FILE}`);
  }

  const browserManifest = await readJson(path.join(sourceRoot, "manifest.json"), "manifest.json");
  const extensionId = validateBrowserManifest(browserManifest);
  const distribution = await readJson(
    path.join(sourceRoot, EXTENSION_DISTRIBUTION_FILE),
    EXTENSION_DISTRIBUTION_FILE
  );
  validateExtensionDistribution(distribution, {
    expectedExtensionId: extensionId,
    expectedExtensionVersion: browserManifest.version
  });

  if (await pathExists(artifactRoot)) {
    const existing = await verifyExtensionArtifact(artifactRoot);
    const existingManifest = await readJson(
      path.join(artifactRoot, EXTENSION_ARTIFACT_MANIFEST),
      EXTENSION_ARTIFACT_MANIFEST
    );
    const existingByPath = new Map(
      existingManifest.artifacts.map((entry) => [entry.path, entry.sha256])
    );
    const identical = existing.extensionVersion === browserManifest.version
      && existing.extensionId === extensionId
      && existingByPath.size === sourceFiles.length
      && (await Promise.all(sourceFiles.map(async (relativePath) => (
        existingByPath.get(relativePath)
          === await sha256File(path.join(sourceRoot, ...relativePath.split("/")))
      )))).every(Boolean);
    if (!identical) {
      throw new Error(
        `Refusing to overwrite immutable extension artifact version at ${artifactRoot}`
      );
    }
    return existingManifest;
  }

  const stagingRoot = `${artifactRoot}.staging-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(artifactRoot), { recursive: true });
  try {
    await mkdir(stagingRoot, { recursive: false });
    for (const relativePath of sourceFiles) {
      const destination = path.join(stagingRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(sourceRoot, ...relativePath.split("/")), destination);
    }

    const artifacts = await Promise.all(sourceFiles.map(async (relativePath) => ({
      path: relativePath,
      sha256: await sha256File(path.join(stagingRoot, ...relativePath.split("/")))
    })));
    const artifactManifest = {
      extension_version: browserManifest.version,
      extension_id: extensionId,
      distribution_contract: EXTENSION_DISTRIBUTION_FILE,
      artifacts
    };
    await writeFile(
      path.join(stagingRoot, EXTENSION_ARTIFACT_MANIFEST),
      `${JSON.stringify(artifactManifest, null, 2)}\n`,
      "utf8"
    );
    await verifyExtensionArtifact(stagingRoot);
    await rename(stagingRoot, artifactRoot);
    return artifactManifest;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function verifyExtensionArtifact(artifactDirectory) {
  const root = path.resolve(artifactDirectory);
  const files = await listRegularFiles(root, {
    excluded: new Set([EXTENSION_ARTIFACT_MANIFEST])
  });
  if (!files.includes("manifest.json")) {
    throw new Error("Extension artifact is missing manifest.json");
  }

  const artifactManifest = await readJson(
    path.join(root, EXTENSION_ARTIFACT_MANIFEST),
    EXTENSION_ARTIFACT_MANIFEST
  );
  const browserManifest = await readJson(path.join(root, "manifest.json"), "manifest.json");
  const expectedExtensionId = validateBrowserManifest(browserManifest);

  if (!artifactManifest || typeof artifactManifest !== "object" || Array.isArray(artifactManifest)) {
    throw new Error(`${EXTENSION_ARTIFACT_MANIFEST} must contain a JSON object`);
  }
  if (artifactManifest.extension_version !== browserManifest.version) {
    throw new Error("Extension artifact version does not match manifest.json");
  }
  if (artifactManifest.extension_id !== expectedExtensionId) {
    throw new Error("Extension artifact ID does not match the manifest.json public key");
  }
  if (!Array.isArray(artifactManifest.artifacts) || artifactManifest.artifacts.length === 0) {
    throw new Error("Extension artifact manifest must contain a non-empty artifacts array");
  }

  const distributionContract = artifactManifest.distribution_contract;
  if (distributionContract === undefined && files.includes(EXTENSION_DISTRIBUTION_FILE)) {
    throw new Error("Extension artifact distribution contract is present but not declared");
  }
  if (distributionContract !== undefined) {
    if (distributionContract !== EXTENSION_DISTRIBUTION_FILE
      || !files.includes(EXTENSION_DISTRIBUTION_FILE)) {
      throw new Error("Extension artifact distribution contract pointer is invalid");
    }
    const distribution = await readJson(
      path.join(root, EXTENSION_DISTRIBUTION_FILE),
      EXTENSION_DISTRIBUTION_FILE
    );
    validateExtensionDistribution(distribution, {
      expectedExtensionId,
      expectedExtensionVersion: browserManifest.version
    });
  }

  const listed = new Set();
  for (const entry of artifactManifest.artifacts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Extension artifact entries must be JSON objects");
    }
    const relativePath = normalizeArtifactPath(entry.path);
    if (relativePath === EXTENSION_ARTIFACT_MANIFEST) {
      throw new Error(`${EXTENSION_ARTIFACT_MANIFEST} cannot inventory itself`);
    }
    if (listed.has(relativePath)) {
      throw new Error(`Duplicate extension artifact entry: ${relativePath}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid SHA-256 digest for extension artifact: ${relativePath}`);
    }
    const actualHash = await sha256File(path.join(root, ...relativePath.split("/")));
    if (actualHash !== entry.sha256) {
      throw new Error(`SHA-256 mismatch for extension artifact: ${relativePath}`);
    }
    listed.add(relativePath);
  }

  const missing = files.filter((relativePath) => !listed.has(relativePath));
  const extra = [...listed].filter((relativePath) => !files.includes(relativePath));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Extension artifact inventory is incomplete (missing: ${missing.join(", ") || "none"}; `
      + `extra: ${extra.join(", ") || "none"})`
    );
  }
  if (!listed.has("manifest.json")) {
    throw new Error("Extension artifact inventory must include manifest.json");
  }

  return {
    extensionVersion: artifactManifest.extension_version,
    extensionId: artifactManifest.extension_id,
    artifactCount: listed.size,
    distributionContract: distributionContract ?? null
  };
}

async function listRegularFiles(root, { excluded = new Set() } = {}) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Extension artifact root must be a regular directory: ${root}`);
  }

  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Extension artifacts cannot contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (!excluded.has(relativePath)) {
          files.push(relativePath);
        }
      } else {
        throw new Error(`Extension artifacts can contain only regular files: ${relativePath}`);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeArtifactPath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\\")) {
    throw new Error(`Invalid extension artifact path: ${String(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid extension artifact path: ${value}`);
  }
  return normalized;
}

function validateBrowserManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest.json must contain a JSON object");
  }
  if (manifest.manifest_version !== 3) {
    throw new Error("Production extension must use manifest version 3");
  }
  if (typeof manifest.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error("manifest.json must contain a non-empty Chrome extension version");
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes("webNavigation")) {
    throw new Error("Production extension must enumerate browser frames with the webNavigation permission");
  }
  const allFrameScript = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts.find((script) =>
        script
        && Array.isArray(script.js)
        && script.js.includes("content_script.js")
        && script.all_frames === true
        && script.match_origin_as_fallback === true
      )
    : null;
  if (!allFrameScript) {
    throw new Error("Production extension must inject content_script.js into all related-origin frames");
  }
  const extensionId = deriveChromeExtensionId(manifest.key);
  if (!/^[a-p]{32}$/.test(extensionId) || extensionId !== RETINA_EXTENSION_ID) {
    throw new Error(`manifest.json public key must produce the fixed Retina extension ID ${RETINA_EXTENSION_ID}`);
  }
  return extensionId;
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`, { cause: error });
  }
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Extension artifact is not a regular file: ${file}`);
  }
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
