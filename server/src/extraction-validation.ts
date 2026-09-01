import type { ExtractionResult } from "@reflection/shared/contracts";

export const EXTRACTION_VALIDATION_VERSION = 2;

declare const validatedExtractionResultBrand: unique symbol;

export type ValidatedExtractionResult = ExtractionResult & {
  readonly [validatedExtractionResultBrand]: typeof EXTRACTION_VALIDATION_VERSION;
};
