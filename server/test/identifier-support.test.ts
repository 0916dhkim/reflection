import { describe, expect, test } from "vitest";

import { copiedSourceSupport } from "../src/identifier-support.js";

describe("identifier source support", () => {
  test("scans a contract-sized lowercase token without regex backtracking", () => {
    expect(copiedSourceSupport("a".repeat(1_000_000))).toEqual(new Set());
  });

  test("scans contract-sized separator input without quadratic backtracking", () => {
    expect(copiedSourceSupport("-".repeat(1_000_000))).toEqual(new Set());
  });

  test("scans contract-sized URI near-misses without quadratic backtracking", () => {
    expect(copiedSourceSupport("a-".repeat(500_000))).toEqual(new Set());
  });

  test("supports only parsed GitHub pull request and issue URLs", () => {
    const supported = [
      ["#13368", "https://github.com/ideogram-ai/ui/pull/13368"],
      ["#14751", "https://www.github.com/ideogram-ai/ui/issues/14751"],
      ["#13368", "See https://github.com/org/repo/pull/13368."],
      ["#133689", "https://github.com/org/repo/pull/13368%39"],
    ] as const;
    for (const [token, source] of supported) {
      expect(copiedSourceSupport(source)).toContain(token);
    }
    expect(
      copiedSourceSupport("https://github.com/org/repo/pull/13368"),
    ).toContain("PR");
    expect(
      copiedSourceSupport("https://github.com/org/repo/issues/14751"),
    ).toContain("Issue");

    const unsupported = [
      ["#14751", 'https://github.com/acme/widgets {"number":14751}'],
      ["#13368", "xhttps://github.com/org/repo/pull/13368"],
      ["#13368", "https://github.com/org/repo/pull/13368draft"],
      ["#13368", "https://github.com/org/repo/pull/13368-foo"],
      ["#13368", "https://github.com/org/repo/pull/13368%64raft"],
      ["#13368", "https://github.com/org/repo/pull/13368%39"],
      ["#13368", "https://github.com/org/repo/pull/13368@evil"],
      ["#13368", "https://github.com/org/repo/pull/13368é"],
      ["#13368", "https://github.com/../repo/pull/13368"],
      ["#4242", "https://github.com\\org\\repo\\pull\\4242"],
      ["#4242", "αhttps://github.com/org/repo/pull/4242"],
      ["#4242", "_https://github.com/org/repo/pull/4242"],
      ["#4242", "https://example.test/pull/4242"],
      ["#77", String.raw`https://notgithub.com {\"number\":77}`],
    ] as const;
    for (const [token, source] of unsupported) {
      expect(copiedSourceSupport(source)).not.toContain(token);
    }
  });

  test("does not synthesize identifiers from separate source fragments", () => {
    const unsupported = [
      ["alpha.beta", "alpha is enabled; beta is disabled"],
      ["a.a.a.a", "a"],
      ["/docs/mat", "Read /docs/format before launch"],
      ["/docs/privacy", "The guide covers /docs/security and privacy"],
      ["/docs/admin", "Use `/docs/format` or `admin`."],
      [
        "/etc/acpi/events/brightness-down",
        "created `/etc/acpi/events/brightness-up` and `brightness-down`.",
      ],
    ] as const;
    for (const [token, source] of unsupported) {
      expect(copiedSourceSupport(source)).not.toContain(token);
    }
  });
});
