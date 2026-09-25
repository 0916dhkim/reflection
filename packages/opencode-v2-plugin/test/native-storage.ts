import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Semaphore, type Schema } from "effect";

type Mutation =
  | { type: "set"; key: string; value: Schema.Json }
  | { type: "remove"; key: string };

// Keep the mutation synchronous inside a real Effect semaphore. A Promise-only
// fake can reject on abort while leaving its queued write alive, hiding the bug.
export function nativeStorage() {
  const semaphore = Semaphore.makeUnsafe(1);
  const values = new Map<string, Schema.Json>();
  const started: Mutation[] = [];
  const applied: Mutation[] = [];
  const finished: Mutation[] = [];
  const observe = { start: (_mutation: Mutation) => {} };
  const mutate = (mutation: Mutation) =>
    Effect.gen(function* () {
      started.push(mutation);
      observe.start(mutation);
      yield* semaphore.withPermit(
        Effect.sync(() => {
          if (mutation.type === "set") values.set(mutation.key, mutation.value);
          else values.delete(mutation.key);
          applied.push(mutation);
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finished.push(mutation);
        }),
      ),
    );
  const storage = {
    get: (key) => Effect.sync(() => values.get(key)),
    set: (key, value) => mutate({ type: "set", key, value }),
    remove: (key) => mutate({ type: "remove", key }),
    scan: ({ prefix }) =>
      Effect.sync(() => ({
        entries: [...values]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      })),
  } satisfies Plugin.Context["storage"];
  return {
    storage,
    values,
    started,
    applied,
    finished,
    observe,
    semaphore,
    hold: () => Effect.runPromise(semaphore.take(1)),
    release: () => Effect.runPromise(semaphore.release(1)),
  };
}
