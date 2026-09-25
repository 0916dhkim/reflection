import type { Plugin as PromisePlugin } from "@opencode/plugin";
import { Plugin } from "@opencode/plugin/effect";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { Effect, type Scope } from "effect";

export interface StorageMutations {
  set(
    key: string,
    value: Parameters<PromisePlugin.Context["storage"]["set"]>[1],
    signal: AbortSignal,
  ): Promise<void>;
  remove(key: string, signal: AbortSignal): Promise<void>;
}

// The pinned Promise adapter starts uncancellable root fibers for storage.
// Capture the native context instead, and interrupt the actual storage fiber
// on timeout/unload so a queued old mutation cannot overwrite newer state.
export function cancellableStorage(storage: Plugin.Context["storage"]) {
  return Effect.gen(function* () {
    const context = yield* Effect.context<Scope.Scope>();
    const run = Effect.runPromiseWith(context);
    return {
      set(key, value, signal) {
        // runPromiseWith starts the fiber before checking its signal.
        signal.throwIfAborted();
        return run(storage.set(key, value), { signal });
      },
      remove(key, signal) {
        signal.throwIfAborted();
        return run(storage.remove(key), { signal });
      },
    } satisfies StorageMutations;
  });
}

export function withCancellableStorage(plugin: {
  id: string;
  setup(
    ctx: PromisePlugin.Context,
    storage: StorageMutations,
  ): ReturnType<PromisePlugin.Plugin["setup"]>;
}) {
  return Plugin.define({
    id: plugin.id,
    effect: (host) =>
      Effect.gen(function* () {
        const storage = yield* cancellableStorage(host.storage);
        yield* fromPromise({
          id: plugin.id,
          setup: (ctx) => plugin.setup(ctx, storage),
        }).effect(host);
      }),
  });
}
