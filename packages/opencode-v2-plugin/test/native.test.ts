import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Exit, Scope } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { cancellableStorage, withCancellableStorage } from "../src/native.js";
import { Operations, bounded } from "../src/operations.js";
import { nativeStorage } from "./native-storage.js";

const scopes: Scope.Closeable[] = [];
function scope() {
  const result = Scope.makeUnsafe();
  scopes.push(result);
  return result;
}
async function adapter(native: ReturnType<typeof nativeStorage>) {
  return Effect.runPromise(
    cancellableStorage(native.storage).pipe(Scope.provide(scope())),
  );
}
afterEach(async () => {
  await Promise.all(
    scopes
      .splice(0)
      .map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["abort", "disposal"])(
  "%s interrupts a queued old write before the synchronous mutation can run",
  async (cancel) => {
    const native = nativeStorage();
    const old = await adapter(native);
    const operations = new Operations();
    const controller = new AbortController();
    await native.hold();
    const pending = operations.run("s", (signal) =>
      bounded(
        old.set(
          "usage",
          "stale A",
          cancel === "abort" ? controller.signal : signal,
        ),
        signal,
      ),
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(native.started).toHaveLength(1));
    expect(native.applied).toEqual([]);
    if (cancel === "abort") controller.abort();
    else await operations.dispose();
    await rejected;
    // The underlying fiber, not just bounded's caller, has finished before the
    // lock is released. Record every applied write to catch transient stale A.
    await vi.waitFor(() => expect(native.finished).toEqual(native.started));
    const next = await adapter(native);
    const saved = next.set("usage", "new B", new AbortController().signal);
    await native.release();
    await saved;
    expect(native.values.get("usage")).toBe("new B");
    expect(native.applied).toEqual([
      { type: "set", key: "usage", value: "new B" },
    ]);
    await operations.dispose();
  },
);

it("does not even construct or start storage effects for already-aborted signals", async () => {
  const native = nativeStorage();
  const storage = await adapter(native);
  native.values.set("usage", "keep");
  const set = vi.spyOn(native.storage, "set");
  const remove = vi.spyOn(native.storage, "remove");
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  expect(() => storage.set("usage", "stale", controller.signal)).toThrow(
    "already cancelled",
  );
  expect(() => storage.remove("usage", controller.signal)).toThrow(
    "already cancelled",
  );
  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(native.started).toEqual([]);
  expect(native.values.get("usage")).toBe("keep");
});

it("the unchanged 60-second operation deadline cancels the queued storage fiber", async () => {
  vi.useFakeTimers();
  const native = nativeStorage();
  const storage = await adapter(native);
  const operations = new Operations();
  const started = new Promise<void>((resolve) => {
    native.observe.start = () => resolve();
  });
  await native.hold();
  const pending = operations.run("s", (signal) =>
    bounded(storage.set("usage", "expired", signal), signal),
  );
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await started;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(native.finished).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(native.finished).toEqual(native.started);
  expect(operations.pending).toBe(0);
  await native.release();
  await storage.set("usage", "new B", new AbortController().signal);
  expect(native.applied).toEqual([
    { type: "set", key: "usage", value: "new B" },
  ]);
  await operations.dispose();
});

it("propagates native storage failure and releases the permit for the next write", async () => {
  const native = nativeStorage();
  const storage = await adapter(native);
  native.values.set("usage", "previous");
  vi.spyOn(native.storage, "set").mockImplementationOnce(() =>
    native.semaphore.withPermit(Effect.die(new Error("disk unavailable"))),
  );
  await expect(
    storage.set("usage", "failed", new AbortController().signal),
  ).rejects.toThrow("disk unavailable");
  expect(native.values.get("usage")).toBe("previous");
  await storage.set("usage", "recovered", new AbortController().signal);
  expect(native.values.get("usage")).toBe("recovered");
  expect(native.applied).toEqual([
    { type: "set", key: "usage", value: "recovered" },
  ]);
});

it("cancels queued removal so it cannot erase the next instance's saved value", async () => {
  const native = nativeStorage();
  const storage = await adapter(native);
  native.values.set("usage", "previous");
  await native.hold();
  const controller = new AbortController();
  const pending = storage.remove("usage", controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  expect(native.started).toEqual([{ type: "remove", key: "usage" }]);
  controller.abort();
  await rejected;
  expect(native.finished).toEqual(native.started);
  await native.release();
  await storage.set("usage", "new B", new AbortController().signal);
  expect(native.values.get("usage")).toBe("new B");
  expect(native.applied).toEqual([
    { type: "set", key: "usage", value: "new B" },
  ]);
  await storage.remove("usage", new AbortController().signal);
  expect(native.values.has("usage")).toBe(false);
});

// The real Promise adapter constructs all SDK domains even when setup only
// uses storage. Unused API methods remain absent and fail if called.
function host(storage: Plugin.Context["storage"]) {
  return {
    app: { name: "opencode", version: "2.0.8", channel: "latest" },
    location: { directory: "/work" },
    options: { marker: "native context" },
    storage,
    agent: {},
    aisdk: {},
    command: {},
    event: {},
    experimental: { terminal: {} },
    generate: {},
    model: {},
    provider: {},
    integration: { connect: {}, oauth: {}, command: {} },
    mcp: {},
    permission: {},
    plugin: {},
    reference: {},
    rpc: {},
    skill: {},
    tool: {},
    vcs: { branch: {} },
    websearch: {},
    worktree: {},
    session: {},
    shell: {},
  } as unknown as Plugin.Context;
}

it("wires native storage into setup and runs its cancellation cleanup on scope close", async () => {
  const native = nativeStorage();
  const pluginScope = scope();
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  const cleanup = vi.fn(async () => {
    controller.abort();
    await pending?.catch(() => {});
  });
  const setup = vi.fn<Parameters<typeof withCancellableStorage>[0]["setup"]>(
    async (ctx, storage) => {
      expect(ctx.options).toEqual({ marker: "native context" });
      expect(storage).not.toBe(ctx.storage);
      // Reads still use the actual Promise SDK adapter.
      expect(await ctx.storage.get("usage")).toBe("previous");
      pending = storage.set("usage", "stale A", controller.signal);
      void pending?.catch(() => {});
      return cleanup;
    },
  );
  const plugin = withCancellableStorage({ id: "storage-test", setup });
  native.values.set("usage", "previous");
  await native.hold();
  await Effect.runPromise(
    plugin.effect(host(native.storage)).pipe(Scope.provide(pluginScope)),
  );
  expect(plugin.id).toBe("storage-test");
  expect(setup).toHaveBeenCalledTimes(1);
  expect(native.started).toHaveLength(1);
  await Effect.runPromise(Scope.close(pluginScope, Exit.void));
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(native.finished).toEqual(native.started);
  await native.release();
  const next = await adapter(native);
  await next.set("usage", "new B", new AbortController().signal);
  expect(native.applied).toEqual([
    { type: "set", key: "usage", value: "new B" },
  ]);
  expect(native.values.get("usage")).toBe("new B");
});
