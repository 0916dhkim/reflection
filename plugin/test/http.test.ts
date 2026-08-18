import { afterEach, describe, expect, it, vi } from "vitest";

import {
  combineAbortSignals,
  requestSignal,
  safeErrorDetail,
} from "../src/http.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("combineAbortSignals", () => {
  it("preserves an existing user abort reason", () => {
    const user = new AbortController();
    const reason = new Error("cancelled by user");
    user.abort(reason);

    const combined = combineAbortSignals([user.signal]);

    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe(reason);
    combined.dispose();
  });

  it("forwards a later user abort", () => {
    const user = new AbortController();
    const combined = combineAbortSignals([user.signal]);

    user.abort("stop");

    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe("stop");
    combined.dispose();
  });
});

describe("requestSignal", () => {
  it("defaults to a 120-second timeout", () => {
    vi.useFakeTimers();
    const request = requestSignal();

    vi.advanceTimersByTime(119_999);
    expect(request.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(request.signal.aborted).toBe(true);
    request.dispose();
  });

  it("aborts after the configured timeout", () => {
    vi.useFakeTimers();
    const request = requestSignal(undefined, 25);

    vi.advanceTimersByTime(25);

    expect(request.signal.aborted).toBe(true);
    expect(String(request.signal.reason)).toContain("timed out after 25ms");
    request.dispose();
  });

  it("preserves a tool abort before the timeout", () => {
    vi.useFakeTimers();
    const user = new AbortController();
    const request = requestSignal(user.signal, 25);

    user.abort("tool cancelled");
    vi.advanceTimersByTime(25);

    expect(request.signal.reason).toBe("tool cancelled");
    request.dispose();
  });
});

describe("safeErrorDetail", () => {
  it("redacts the API key, normalizes whitespace, and bounds output", () => {
    const detail = safeErrorDetail(
      `failure\nsecret-key\t${"x".repeat(600)}`,
      "secret-key",
    );

    expect(detail).not.toContain("secret-key");
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toMatch(/\s{2}/);
    expect(detail.length).toBeLessThanOrEqual(500);
  });
});
