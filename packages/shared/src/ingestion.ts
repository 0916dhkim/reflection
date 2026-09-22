import { Type } from "@sinclair/typebox";

import {
  ContractValidationError,
  type JobResponse,
  type SegmentCreate,
  type SegmentResponse,
  type SessionSegmentsResponse,
} from "./contracts.js";
import {
  type ProjectionFingerprintBoundary,
  projectionFingerprintForBoundary,
  sourceFingerprint,
} from "./domain.js";
import {
  type NativeJobResponse,
  type NativeSegmentCreate,
  type NativeSegmentResponse,
  type NativeSessionSegmentsResponse,
  NativeJobResponseSchema,
  NativeSegmentCreateSchema,
  NativeSegmentResponseSchema,
  NativeSessionSegmentsResponseSchema,
  nativeProjectionFingerprint,
  nativeSegmentIdForRequest,
  nativeSourceFingerprint,
  parseNativeJobResponse,
  parseNativeSegmentCreate,
  parseNativeSegmentResponse,
  parseNativeSessionSegmentsResponse,
} from "./native.js";
import {
  type SourceInfo,
  type SourceJobResponse,
  type SourceSegmentCreate,
  type SourceSegmentResponse,
  type SourceSessionSegmentsResponse,
  SourceSessionSegmentsResponseSchema,
  SourceJobResponseSchema,
  SourceSegmentCreateSchema,
  SourceSegmentResponseSchema,
  decodePersistedSegment,
  parseSourceId,
  parseSourceJobResponse,
  parseSourceSegmentCreate,
  parseSourceSegmentResponse,
  parseSourceSessionSegmentsResponse,
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

export type IngestSessionSegmentsResponse =
  | SourceSessionSegmentsResponse
  | NativeSessionSegmentsResponse;

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

export const IngestSessionSegmentsResponseSchema = Type.Union([
  SourceSessionSegmentsResponseSchema,
  NativeSessionSegmentsResponseSchema,
]);

export function parseIngestSessionSegmentsResponse(
  value: unknown,
  expectedSourceId?: string,
): IngestSessionSegmentsResponse {
  return record(value)?.manifest_version === 3
    ? parseNativeSessionSegmentsResponse(value, expectedSourceId)
    : parseSourceSessionSegmentsResponse(value, expectedSourceId);
}

export type {
  JobResponse,
  SegmentResponse,
  SessionSegmentsResponse,
  SourceSessionSegmentsResponse,
};
