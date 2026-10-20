import { describe, expect, it } from "vitest";
import { estimateNativeTokens, nativeInputBudget } from "../src/projection.js";

describe("native context budget", () => {
  it("uses 70% of context for projection and 75% for the hard ceiling", () => {
    expect(nativeInputBudget(1_048_576, undefined, 262_144)).toEqual({
      soft: 734_003,
      hard: 786_432,
    });
    expect(nativeInputBudget(20_000, 10_000, 2000)).toEqual({
      soft: 9333,
      hard: 10_000,
    });
    expect(nativeInputBudget(20_000, undefined, 8000)).toEqual({
      soft: 11_200,
      hard: 12_000,
    });
    expect(() => nativeInputBudget(20_000, undefined, 20_000)).toThrow(
      "no usable input budget",
    );
  });

  it("estimates unicode structure and rejects opaque media explicitly", () => {
    expect(estimateNativeTokens("漢".repeat(100))).toBeGreaterThan(
      estimateNativeTokens("a".repeat(100)),
    );
    expect(estimateNativeTokens({ type: "image", data: "x" })).toBeGreaterThan(
      4096,
    );
    expect(() => estimateNativeTokens(new Uint8Array([1, 2]))).toThrow(
      /media policy/,
    );
    expect(() =>
      estimateNativeTokens({ type: "file", data: "binary" }),
    ).toThrow(/media policy/);
  });
});
