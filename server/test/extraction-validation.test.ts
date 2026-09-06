import { type ExtractionResult } from "@reflection/shared/contracts";
import { describe, expect, test } from "vitest";

import {
  MAX_REPORT_SUBJECT_CLAIMS,
  boundReportSubjectClaims,
} from "../src/extraction-validation.js";

function resultWithSubjects(subjects: readonly string[]): ExtractionResult {
  return {
    summary: "Summary",
    claims: subjects.map((subject, index) => ({
      subject,
      predicate: "records",
      confidence: 0.9,
      object_entity: null,
      object_value: `claim ${index}`,
    })),
  };
}

describe("boundReportSubjectClaims", () => {
  test("caps report subjects while preserving claim order and input", () => {
    const input = resultWithSubjects([
      "Foo review report",
      "ideogram-ui BrowsingState",
      "Foo audit",
      "Foo assessment",
      "ideogram-ui BrowsingState",
      "Foo investigation",
    ]);
    const original = structuredClone(input);

    const bounded = boundReportSubjectClaims(input);

    expect(bounded.dropped).toBe(1);
    expect(bounded.result).not.toBe(input);
    expect(bounded.result.claims.map((claim) => claim.subject)).toEqual([
      "Foo review report",
      "ideogram-ui BrowsingState",
      "Foo audit",
      "Foo assessment",
      "ideogram-ui BrowsingState",
    ]);
    expect(input).toEqual(original);
  });

  test("does not change results with at most three report subjects", () => {
    const input = resultWithSubjects(["Foo review", "Foo audit", "Foo report"]);

    const bounded = boundReportSubjectClaims(input);

    expect(MAX_REPORT_SUBJECT_CLAIMS).toBe(3);
    expect(bounded).toEqual({ result: input, dropped: 0 });
  });

  test("matches report subjects case-insensitively", () => {
    const input = resultWithSubjects([
      "Foo REVIEW",
      "Foo Audit",
      "Foo ASSESSMENT",
      "Foo Investigation",
    ]);

    const bounded = boundReportSubjectClaims(input);

    expect(bounded.dropped).toBe(1);
    expect(bounded.result.claims.map((claim) => claim.subject)).toEqual(
      input.claims.slice(0, 3).map((claim) => claim.subject),
    );
  });

  test("leaves non-matching subjects untouched", () => {
    const input = resultWithSubjects([
      "ideogram-ui BrowsingState",
      "Reviewers guide",
      "ReportGenerator",
      "Inspectional project",
      "Foo validation runbook",
    ]);

    expect(boundReportSubjectClaims(input)).toEqual({
      result: input,
      dropped: 0,
    });
  });
});
