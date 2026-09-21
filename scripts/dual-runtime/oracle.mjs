export { canonicalizeNativeHistory } from "../../packages/opencode-v2-core/src/history.ts";
export { hydrateNativeRange } from "../../packages/opencode-v2-core/src/segmentation.ts";
export { estimateNativeTokens } from "../../packages/opencode-v2-core/src/projection.ts";
export { readSegmentMessages } from "../../packages/shared/src/segmentation.ts";
export { legacyHistory } from "../../packages/opencode-v2-plugin/src/transport.ts";
export {
  ingestSegmentIdForRequest,
  ingestSourceFingerprint,
  ownedIngestRequest,
} from "../../packages/shared/src/ingestion.ts";
export {
  segmentIdForRequest,
  sourceFingerprint,
} from "../../packages/shared/src/domain.ts";
