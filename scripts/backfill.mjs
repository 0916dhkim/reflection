import { registerHooks } from "node:module";

const sharedSources = new Map(
  ["contracts", "domain", "segmentation"].map((module) => [
    `@reflection/shared/${module}`,
    new URL(`../packages/shared/src/${module}.ts`, import.meta.url).href,
  ]),
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const sharedSource = sharedSources.get(specifier);
    if (sharedSource) return nextResolve(sharedSource, context);
    if (
      specifier.startsWith("./") &&
      specifier.endsWith(".js") &&
      context.parentURL?.includes("/packages/shared/src/")
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { main } = await import("./src/backfill.ts");

export async function launch(run = main) {
  process.exitCode = await run();
}

if (import.meta.main) await launch();
