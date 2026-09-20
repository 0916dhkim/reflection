import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const report = {
  revisions: JSON.parse(readFileSync("/harness/provenance.json", "utf8")),
  runtime: {
    node: process.version,
    pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
  },
  builds: {},
  harness: {},
};
for (const version of ["old", "new"]) {
  const root = `/versions/${version}`;
  const meta = JSON.parse(readFileSync(`${root}/backend-meta.json`, "utf8"));
  const inputs = Object.keys(meta.inputs).map((input) => resolve(root, input));
  if (
    inputs.some(
      (input) =>
        input.startsWith("/versions/") && !input.startsWith(`${root}/`),
    )
  ) {
    throw new Error(`Cross-revision dependency in ${version} backend`);
  }
  for (const required of [
    "server/src/app.ts",
    "server/src/database.ts",
    "server/src/worker.ts",
    "packages/shared/src/contracts.ts",
  ]) {
    if (!inputs.includes(`${root}/${required}`))
      throw new Error(`Missing pinned input: ${version}/${required}`);
  }
  report.builds[version] = {
    backendSha256: sha256(`${root}/server/rehearsal.mjs`),
    pluginSha256: sha256(`${root}/plugin/dist/reflection.js`),
    lockfileSha256: sha256(`${root}/pnpm-lock.yaml`),
    migrations: Object.fromEntries(
      readdirSync(`${root}/migrations`)
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map((name) => [name, sha256(`${root}/migrations/${name}`)]),
    ),
    verifiedBackendInputs: inputs.length,
  };
}
for (const file of ["backend.mjs", "plugin-child.mjs", "scenario.mjs"])
  report.harness[file] = sha256(`/harness/${file}`);
writeFileSync(
  "/harness/runtime-provenance.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
