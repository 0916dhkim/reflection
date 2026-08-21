import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "reflection-plugin-"));

try {
  const bundle = join(directory, "reflection.js");
  await copyFile(join(root, "dist", "reflection.js"), bundle);
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');

  if ((await readdir(directory)).includes("node_modules")) {
    throw new Error(
      "isolated verification directory unexpectedly has node_modules",
    );
  }

  const plugin = await import(pathToFileURL(bundle).href);
  if (typeof plugin.default !== "function") {
    throw new Error("bundle has no default plugin export");
  }
  const exports = Object.keys(plugin).sort();
  if (JSON.stringify(exports) !== JSON.stringify(["Reflection", "default"])) {
    throw new Error(
      `bundle has unexpected plugin exports: ${exports.join(", ")}`,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
