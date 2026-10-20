import { describe, expect, it } from "vitest";
import {
  formatAnchorMissing,
  formatProjectionDecision,
  formatRequestFailure,
} from "../src/log.js";

describe("failure diagnostics", () => {
  it("includes the full URL, timeout, elapsed time, and fetch cause", () => {
    const line = formatRequestFailure({
      operation: "session.read",
      target: "source",
      method: "GET",
      url: "http://127.0.0.1:4096/api/session/ses_1?location%5Bdirectory%5D=%2Fwork",
      elapsedMs: 12.34,
      timeoutMs: 5000,
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket closed"), {
          code: "ECONNRESET",
        }),
      }),
    });
    expect(line).toContain("request-failed");
    expect(line).toContain("op=session.read");
    expect(line).toContain("target=source");
    expect(line).toContain("method=GET");
    expect(line).toContain(
      'url="http://127.0.0.1:4096/api/session/ses_1?location%5Bdirectory%5D=%2Fwork"',
    );
    expect(line).toContain("status=none");
    expect(line).toContain("elapsed_ms=12.3");
    expect(line).toContain("timeout_ms=5000");
    expect(line).toContain("error=TypeError");
    expect(line).toContain('error_message="fetch failed"');
    expect(line).toContain("cause=ECONNRESET");
  });

  it("includes HTTP status without an error cause", () => {
    const line = formatRequestFailure({
      operation: "manifest.read",
      target: "backend",
      method: "GET",
      url: "https://reflection.invalid/v1/sessions/s/segments?source_id=s",
      status: 503,
      elapsedMs: 4.2,
      timeoutMs: 5000,
    });
    expect(line).toContain("status=503");
    expect(line).not.toContain("error=");
  });

  it("describes why a usage anchor is missing", () => {
    expect(
      formatAnchorMissing({
        session: "ses_1",
        reason: "latest-assistant-no-usage",
        previousAnchor: true,
        latest: "msg_1",
        latestUsage: 0,
      }),
    ).toBe(
      "usage-anchor-missing session=ses_1 reason=latest-assistant-no-usage previous_anchor=present latest=msg_1 latest_usage=0",
    );
  });

  it("records the projection mode, budget, and estimate source", () => {
    const decision = {
      session: "ses_1",
      mode: "fired" as const,
      estimatedTokens: 712345,
      measured: false,
      soft: 734003,
      hard: 786432,
      summaries: 460,
      omitted: 2,
      missing: 1,
    };
    expect(formatProjectionDecision(decision)).toBe(
      "projection session=ses_1 mode=fired estimated_tokens=712345 estimate_source=heuristic soft=734003 hard=786432 summaries=460 omitted=2 missing=1",
    );
    expect(
      formatProjectionDecision({ ...decision, mode: "kept", measured: true }),
    ).toContain("mode=kept estimated_tokens=712345 estimate_source=provider");
  });
});
