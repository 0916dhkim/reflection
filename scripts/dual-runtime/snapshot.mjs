import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export function snapshot(root, destination) {
  const list = (args) =>
    execFileSync("git", ["ls-files", "-z", ...args], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
  const paths = [
    ...new Set([
      ...list(["--cached"]),
      ...list([
        "--others",
        "--exclude-standard",
        "--",
        "scripts/dual-runtime/",
      ]),
    ]),
  ].sort();
  const files = {};
  for (const path of paths) {
    const components = path.split("/");
    if (isAbsolute(path) || components.includes(".."))
      throw new Error("unsafe snapshot path");
    if (components.some((name) => name === ".env" || name.startsWith(".env.")))
      continue;
    let source = root;
    let missing = false;
    for (let index = 0; index < components.length; index++) {
      source = join(source, components[index]);
      let info;
      try {
        info = lstatSync(source);
      } catch (error) {
        if (error.code === "ENOENT") {
          missing = true;
          break;
        }
        throw error;
      }
      if (
        info.isSymbolicLink() ||
        (index === components.length - 1 ? !info.isFile() : !info.isDirectory())
      )
        throw new Error("snapshot refuses symlinks and special files");
    }
    if (missing) continue;
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    files[path] = createHash("sha256")
      .update(readFileSync(target))
      .digest("hex");
  }
  return files;
}
