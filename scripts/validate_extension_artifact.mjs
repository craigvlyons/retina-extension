import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyExtensionArtifact } from "./extension-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const artifactDirectory = path.resolve(
  process.argv[2] || path.join(root, "dist", "artifacts", "retina-extension", packageMetadata.version)
);
const result = await verifyExtensionArtifact(artifactDirectory);
process.stdout.write(`${JSON.stringify({ artifactDirectory, ...result }, null, 2)}\n`);
