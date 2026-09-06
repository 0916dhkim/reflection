import type { ExtractionResult } from "@reflection/shared/contracts";

export const EXTRACTION_VALIDATION_VERSION = 3;
export const MAX_REPORT_SUBJECT_CLAIMS = 3;
// Subjects that name an inspection/review artifact rather than the thing inspected.
export const REPORT_SUBJECT_PATTERN =
  /\b(inspection|review|report|audit|assessment|investigation|walkthrough|validation run|patch application)\b/i;

export function boundReportSubjectClaims(result: ExtractionResult): {
  result: ExtractionResult;
  dropped: number;
} {
  let reportSubjectClaims = 0;
  const claims = result.claims.filter((claim) => {
    if (!REPORT_SUBJECT_PATTERN.test(claim.subject)) return true;
    reportSubjectClaims += 1;
    return reportSubjectClaims <= MAX_REPORT_SUBJECT_CLAIMS;
  });

  return {
    result: { ...result, claims },
    dropped: result.claims.length - claims.length,
  };
}

declare const validatedExtractionResultBrand: unique symbol;

export type ValidatedExtractionResult = ExtractionResult & {
  readonly [validatedExtractionResultBrand]: typeof EXTRACTION_VALIDATION_VERSION;
};
