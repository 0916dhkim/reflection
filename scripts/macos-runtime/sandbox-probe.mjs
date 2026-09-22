import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// Executed only by the guarded CI runner, inside a narrower disposable root.
const [allowed, outside, origin] = process.argv.slice(2);
await writeFile(join(allowed, "allowed.txt"), "allowed");
assert.equal(await readFile(join(allowed, "allowed.txt"), "utf8"), "allowed");
await assert.rejects(writeFile(outside, "escape"), (error) =>
  ["EPERM", "EACCES"].includes(error.code),
);
const response = await fetch(`${origin}/v1/sources/fixture-mac-v2`, {
  headers: { "x-api-key": "fixture-only" },
  signal: AbortSignal.timeout(3000),
});
assert.equal(response.status, 200);
await response.body.cancel();
await assert.rejects(
  fetch("http://127.0.0.1:4096", { signal: AbortSignal.timeout(2000) }),
);
process.stdout.write("sandbox-boundary-ok\n");
