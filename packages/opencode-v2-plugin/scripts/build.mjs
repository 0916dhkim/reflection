import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/reflection-v2.js", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: 'import { createRequire as __reflectionCreateRequire } from "node:module"; const require = __reflectionCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});
