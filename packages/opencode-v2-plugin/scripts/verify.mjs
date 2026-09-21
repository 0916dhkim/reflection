import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
// Import the byte-identical artifact from a fresh directory outside the repo.
const directory = await mkdtemp(join(tmpdir(), "reflection-v2-standalone-"));
try {
  const file = join(directory, "reflection-v2.mjs");
  await copyFile(new URL("../dist/reflection-v2.js", import.meta.url), file);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
  const mod = await import(${JSON.stringify(pathToFileURL(file).href)});
  if (mod.default?.id !== 'reflection-v2' || typeof mod.default.setup !== 'function') throw Error('invalid plugin');
  console.log('Standalone Reflection v2 bundle imported');
`,
    ],
    {
      cwd: directory,
      env: { ...process.env, NODE_PATH: "" },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "standalone import failed");
  process.stdout.write(result.stdout);
} finally {
  await rm(directory, { recursive: true, force: true });
}
