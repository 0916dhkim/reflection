import { expect, it } from "vitest";
import { Operations, bounded } from "../src/operations.js";

it("aborts and drains active operations and queued work on disposal", async () => {
  const operations = new Operations();
  const task = operations.queue("s", () =>
    operations.run("s", (signal) =>
      bounded(new Promise<void>(() => {}), signal),
    ),
  );
  const queued = operations.queue("s", async () => {
    throw new Error("must not start");
  });
  const settled = Promise.allSettled([task, queued]);
  await Promise.resolve();
  await Promise.resolve();
  await operations.dispose();
  expect((await settled).every((result) => result.status === "rejected")).toBe(
    true,
  );
  expect(operations.pending).toBe(0);
});
it("deletion aborts session work then removes its checkpoint and forbids reentry", async () => {
  const operations = new Operations();
  const task = operations.queue("s", () =>
    operations.run("s", (signal) =>
      bounded(new Promise<void>(() => {}), signal),
    ),
  );
  const caught = task.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  let removed = false;
  await operations.delete("s", async () => {
    removed = true;
  });
  await caught;
  expect(removed).toBe(true);
  await expect(operations.run("s", async () => {})).rejects.toThrow("deletion");
  expect(operations.pending).toBe(0);
});
