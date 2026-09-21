import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  ContractValidationError,
  type JobResponse,
  type SegmentBoundary,
  type SegmentCreate,
  type SegmentResponse,
  type SegmentSummary,
  type SegmentTargetBoundary,
  type SessionSegmentsResponse,
  SegmentBoundarySchema,
  SegmentSummarySchema,
  SegmentTargetBoundarySchema,
  parseSessionSegmentsResponse,
} from "./contracts.js";
import {
  type ProjectionFingerprintBoundary,
  projectionFingerprintForBoundary,
  sourceFingerprint,
} from "./domain.js";
import {
  type NativeJobResponse,
  type NativeSegmentBoundary,
  type NativeSegmentCreate,
  type NativeSegmentResponse,
  type NativeSegmentSummary,
  type NativeSegmentTargetBoundary,
  NativeJobResponseSchema,
  NativeSegmentCreateSchema,
  NativeSegmentResponseSchema,
  NativeSegmentBoundarySchema,
  NativeSegmentSummarySchema,
  NativeSegmentTargetBoundarySchema,
  nativeProjectionFingerprint,
  nativeSegmentIdForRequest,
  nativeSourceFingerprint,
  parseNativeJobResponse,
  parseNativeSegmentBoundary,
  parseNativeSegmentCreate,
  parseNativeSegmentResponse,
  parseNativeSegmentSummary,
  parseNativeSegmentTargetBoundary,
} from "./native.js";
import {
  type SourceInfo,
  type SourceJobResponse,
  type SourceSegmentCreate,
  type SourceSegmentResponse,
  type SourceSessionSegmentsResponse,
  SourceIdSchema,
  SourceJobResponseSchema,
  SourceSegmentCreateSchema,
  SourceSegmentResponseSchema,
  decodePersistedSegment,
  parseSourceId,
  parseSourceJobResponse,
  parseSourceSegmentCreate,
  parseSourceSegmentResponse,
  sourceSegmentIdForRequest,
} from "./sources.js";

export type IngestSegmentCreate = SourceSegmentCreate | NativeSegmentCreate;
export type PersistedIngestRequest = SegmentCreate | NativeSegmentCreate;
export type IngestJobResponse = SourceJobResponse | NativeJobResponse;
export type IngestSegmentResponse =
  | SourceSegmentResponse
  | NativeSegmentResponse;

export const IngestSegmentCreateSchema = Type.Union([
  SourceSegmentCreateSchema,
  NativeSegmentCreateSchema,
]);
export const IngestJobResponseSchema = Type.Union([
  SourceJobResponseSchema,
  NativeJobResponseSchema,
]);
export const IngestSegmentResponseSchema = Type.Union([
  SourceSegmentResponseSchema,
  NativeSegmentResponseSchema,
]);

export interface IngestSessionSegmentsResponse {
  source_id: string;
  manifest_version: 2;
  session_id: string;
  segments: Array<SegmentSummary | NativeSegmentSummary>;
  boundaries: Array<SegmentBoundary | NativeSegmentBoundary>;
  targets: Array<SegmentTargetBoundary | NativeSegmentTargetBoundary>;
}

export type IngestProjectionFingerprintBoundary =
  | ProjectionFingerprintBoundary
  | Pick<
      NativeSegmentCreate,
      "source_boundary_version" | "end_source_message_id"
    >;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasNativeBoundary(value: unknown): boolean {
  return record(value)?.source_boundary_version === 3;
}

function parse<T extends TSchema>(
  name: string,
  schema: T,
  value: unknown,
): Static<T> {
  if (!Value.Check(schema, value)) {
    throw new ContractValidationError(name, schema, value);
  }
  return value as Static<T>;
}

export function parseIngestSegmentCreate(value: unknown): IngestSegmentCreate {
  return hasNativeBoundary(value)
    ? parseNativeSegmentCreate(value)
    : parseSourceSegmentCreate(value);
}

export function decodePersistedIngestSegment(
  value: unknown,
  assignedSourceId: string,
): IngestSegmentCreate {
  if (!hasNativeBoundary(value)) {
    return decodePersistedSegment(value, assignedSourceId);
  }
  const native = parseNativeSegmentCreate(value);
  const sourceId = parseSourceId(assignedSourceId, "assigned source");
  if (native.source_id !== sourceId) {
    throw new ContractValidationError(
      "persisted native segment source",
      Type.Object({ source_id: Type.Literal(sourceId) }),
      native,
    );
  }
  return native;
}

export function ownedIngestRequest(
  request: PersistedIngestRequest,
  sourceId: string,
): IngestSegmentCreate {
  if (request.source_boundary_version !== 3) {
    return decodePersistedSegment(request, sourceId);
  }
  const native = parseNativeSegmentCreate(request);
  const assignedSourceId = parseSourceId(sourceId, "assigned source");
  if (native.source_id !== assignedSourceId) {
    throw new ContractValidationError(
      "native segment request source",
      Type.Object({ source_id: Type.Literal(assignedSourceId) }),
      native,
    );
  }
  return native;
}

export function ingestSegmentIdForRequest(
  request: IngestSegmentCreate,
  source: SourceInfo,
): string {
  return request.source_boundary_version === 3
    ? nativeSegmentIdForRequest(request, source)
    : sourceSegmentIdForRequest(request, source);
}

export function ingestSourceFingerprint(request: IngestSegmentCreate): string {
  return request.source_boundary_version === 3
    ? nativeSourceFingerprint(request)
    : sourceFingerprint(request);
}

export function ingestProjectionFingerprintForBoundary(
  segmentId: string,
  boundary: IngestProjectionFingerprintBoundary,
  summary: string,
  projectionVersion: number,
): string {
  if ("source_boundary_version" in boundary) {
    return nativeProjectionFingerprint(
      segmentId,
      boundary.end_source_message_id,
      summary,
      projectionVersion,
    );
  }
  return projectionFingerprintForBoundary(
    segmentId,
    boundary,
    summary,
    projectionVersion,
  );
}

export function parseIngestJobResponse(
  value: unknown,
  expectedSourceId?: string,
): IngestJobResponse {
  return hasNativeBoundary(value)
    ? parseNativeJobResponse(value, expectedSourceId)
    : parseSourceJobResponse(value, expectedSourceId);
}

export function parseIngestSegmentResponse(
  value: unknown,
  expectedSourceId?: string,
): IngestSegmentResponse {
  return hasNativeBoundary(value)
    ? parseNativeSegmentResponse(value, expectedSourceId)
    : parseSourceSegmentResponse(value, expectedSourceId);
}

export const IngestSessionSegmentsResponseSchema = Type.Object(
  {
    source_id: SourceIdSchema,
    manifest_version: Type.Literal(2),
    session_id: Type.String(),
    segments: Type.Array(
      Type.Union([SegmentSummarySchema, NativeSegmentSummarySchema]),
    ),
    boundaries: Type.Array(
      Type.Union([SegmentBoundarySchema, NativeSegmentBoundarySchema]),
    ),
    targets: Type.Array(
      Type.Union([
        SegmentTargetBoundarySchema,
        NativeSegmentTargetBoundarySchema,
      ]),
    ),
  },
  { additionalProperties: false },
);

function parseLegacySummary(value: unknown): SegmentSummary {
  return parseSessionSegmentsResponse({
    manifest_version: 2,
    session_id: "legacy-manifest-entry",
    segments: [value],
    boundaries: [],
    targets: [],
  }).segments[0]!;
}

function parseLegacyBoundary(value: unknown): SegmentBoundary {
  return parseSessionSegmentsResponse({
    manifest_version: 2,
    session_id: "legacy-manifest-entry",
    segments: [],
    boundaries: [value],
    targets: [],
  }).boundaries[0]!;
}

function parseLegacyTarget(value: unknown): SegmentTargetBoundary {
  return parseSessionSegmentsResponse({
    manifest_version: 2,
    session_id: "legacy-manifest-entry",
    segments: [],
    boundaries: [],
    targets: [value],
  }).targets[0]!;
}

export function parseIngestSessionSegmentsResponse(
  value: unknown,
  expectedSourceId?: string,
): IngestSessionSegmentsResponse {
  const object = record(value);
  const normalized = object
    ? {
        ...object,
        source_id: parseSourceId(object.source_id, "ingest manifest"),
      }
    : value;
  const manifest = parse(
    "ingest session segments response",
    IngestSessionSegmentsResponseSchema,
    normalized,
  );
  if (
    expectedSourceId !== undefined &&
    manifest.source_id !== parseSourceId(expectedSourceId, "ingest manifest")
  ) {
    throw new ContractValidationError(
      "ingest session segments response",
      Type.Object({ source_id: Type.Literal(expectedSourceId) }),
      manifest,
    );
  }
  return {
    source_id: manifest.source_id,
    manifest_version: manifest.manifest_version,
    session_id: manifest.session_id,
    segments: manifest.segments.map((entry) =>
      hasNativeBoundary(entry)
        ? parseNativeSegmentSummary(entry)
        : parseLegacySummary(entry),
    ),
    boundaries: manifest.boundaries.map((entry) =>
      hasNativeBoundary(entry)
        ? parseNativeSegmentBoundary(entry)
        : parseLegacyBoundary(entry),
    ),
    targets: manifest.targets.map((entry) =>
      hasNativeBoundary(entry)
        ? parseNativeSegmentTargetBoundary(entry)
        : parseLegacyTarget(entry),
    ),
  };
}

export type {
  JobResponse,
  SegmentResponse,
  SessionSegmentsResponse,
  SourceSessionSegmentsResponse,
};
