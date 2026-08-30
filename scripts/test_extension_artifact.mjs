import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EXTENSION_ARTIFACT_MANIFEST,
  RETINA_EXTENSION_ID,
  deriveChromeExtensionId,
  publishExtensionArtifact,
  verifyExtensionArtifact
} from "./extension-artifact.mjs";
import {
  EXTENSION_DISTRIBUTION_FILE,
  createExtensionDistribution
} from "./extension-distribution.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "retina-extension-artifact-test-"));
try {
  const source = path.join(temporaryRoot, "source");
  const artifact = path.join(temporaryRoot, "artifact");
  await mkdir(path.join(source, "assets"), { recursive: true });
  const publicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6i74fY/HeOHi2XOXC4w0YSjerWSWr84M/Cumh5I2g90F1aZdOn6mYpqc3BzK57xr2cG6rl2BZulTeSErglNGg4Z4poMJSIT0D88B0vo/LJz2FD8faGFJIH5K1uS5pedMLVDDwEkvMA6HvCIB+o/F2nMEDoO9xRlLnkYoMW6WsB/BcM4cBALLC+h6Js6N5aKY+IDLwvmpUtWD7QR6VUGu7oWUq83ntZM2Y5nFC8leVxEkS/D9kzL+yXjXKllQiVp3bWBDzcGsOIwfgq6RlyNfTOLeitHnxRSGZiwLjUKwgVWTp4I+TJLH0mZVU1gDoLjaS/bVTyybsb9TyxJEdMK0UQIDAQAB";
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "Retina test",
    version: "2.1.0",
    key: publicKey,
    permissions: ["webNavigation"],
    content_scripts: [{
      matches: ["<all_urls>"],
      js: ["content_script.js"],
      all_frames: true,
      match_origin_as_fallback: true
    }]
  }));
  await writeFile(path.join(source, "content_script.js"), "console.log('content script');\n");
  await writeFile(
    path.join(source, EXTENSION_DISTRIBUTION_FILE),
    JSON.stringify(createExtensionDistribution({
      extensionId: RETINA_EXTENSION_ID,
      extensionVersion: "2.1.0"
    }))
  );
  await writeFile(path.join(source, "assets", "worker.js"), "console.log('test');\n");

  const missingDistributionSource = path.join(temporaryRoot, "missing-distribution-source");
  await mkdir(missingDistributionSource, { recursive: true });
  await writeFile(
    path.join(missingDistributionSource, "manifest.json"),
    await readFile(path.join(source, "manifest.json"))
  );
  await assert.rejects(
    publishExtensionArtifact({
      sourceDirectory: missingDistributionSource,
      artifactDirectory: path.join(temporaryRoot, "missing-distribution-artifact")
    }),
    /missing extension-distribution\.json/
  );

  const published = await publishExtensionArtifact({
    sourceDirectory: source,
    artifactDirectory: artifact
  });
  assert.equal(published.extension_version, "2.1.0");
  assert.equal(published.extension_id, RETINA_EXTENSION_ID);
  assert.equal(deriveChromeExtensionId(publicKey), published.extension_id);
  assert.equal(published.distribution_contract, EXTENSION_DISTRIBUTION_FILE);
  assert.deepEqual(published.artifacts.map(({ path: file }) => file), [
    "assets/worker.js",
    "content_script.js",
    EXTENSION_DISTRIBUTION_FILE,
    "manifest.json"
  ]);

  const verified = await verifyExtensionArtifact(artifact);
  assert.equal(verified.artifactCount, 4);
  assert.equal(verified.distributionContract, EXTENSION_DISTRIBUTION_FILE);
  assert.match(
    await readFile(path.join(artifact, EXTENSION_ARTIFACT_MANIFEST), "utf8"),
    /"sha256": "[a-f0-9]{64}"/
  );

  const republished = await publishExtensionArtifact({
    sourceDirectory: source,
    artifactDirectory: artifact
  });
  assert.deepEqual(republished, published);

  await writeFile(path.join(source, "assets", "worker.js"), "different release bytes\n");
  await assert.rejects(
    publishExtensionArtifact({
      sourceDirectory: source,
      artifactDirectory: artifact
    }),
    /Refusing to overwrite immutable extension artifact version/
  );
  await writeFile(path.join(source, "assets", "worker.js"), "console.log('test');\n");

  const invalidDistribution = createExtensionDistribution({
    extensionId: RETINA_EXTENSION_ID,
    extensionVersion: "2.1.0"
  });
  invalidDistribution.channels.chromeWebStore = {
    available: true,
    published: true,
    url: "https://example.invalid/unpublished"
  };
  await writeFile(
    path.join(source, EXTENSION_DISTRIBUTION_FILE),
    JSON.stringify(invalidDistribution)
  );
  await assert.rejects(
    publishExtensionArtifact({
      sourceDirectory: source,
      artifactDirectory: path.join(temporaryRoot, "invalid-distribution-artifact")
    }),
    /must not claim unavailable store or policy assets/
  );
  await writeFile(
    path.join(source, EXTENSION_DISTRIBUTION_FILE),
    JSON.stringify(createExtensionDistribution({
      extensionId: RETINA_EXTENSION_ID,
      extensionVersion: "2.1.0"
    }))
  );

  await writeFile(path.join(artifact, "assets", "worker.js"), "tampered\n");
  await assert.rejects(
    verifyExtensionArtifact(artifact),
    /SHA-256 mismatch for extension artifact: assets\/worker\.js/
  );

  await writeFile(path.join(artifact, "assets", "worker.js"), "console.log('test');\n");
  await writeFile(path.join(artifact, "unlisted.txt"), "not inventoried\n");
  await assert.rejects(
    verifyExtensionArtifact(artifact),
    /inventory is incomplete \(missing: unlisted\.txt; extra: none\)/
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("Extension artifact publication tests passed.\n");
