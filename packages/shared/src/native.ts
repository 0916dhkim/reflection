import { createHash } from "node:crypto";

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { v5 as uuidv5 } from "uuid";

import {
  ClaimDataSchema,
  ContractValidationError,
  IdentifierSchema,
  JobResponseMetadataProperties,
  MAX_MESSAGE_TEXT_CHARS,
  MAX_SEGMENT_TEXT_CHARS,
  SegmentBoundaryMetadataProperties,
  SegmentResponseMetadataProperties,
  SegmentSummaryMetadataProperties,
  SegmentTargetBoundaryMetadataProperties,
  codePointLength,
  validateClaimObject,
} from "./contracts.js";
import { SEGMENT_NAMESPACE } from "./domain.js";
import {
  type SourceInfo,
  SourceIdSchema,
  parseSourceId,
  parseSourceInfo,
} from "./sources.js";

const NativeBoundaryProperties = {
  source_boundary_version: Type.Literal(3),
  start_source_message_id: IdentifierSchema,
  end_source_message_id: IdentifierSchema,
} as const;

const NativeMessageTypeSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
  Type.Literal("synthetic"),
  Type.Literal("shell"),
  Type.Literal("skill"),
  Type.Literal("system"),
  Type.Literal("compaction"),
  Type.Literal("idle"),
  Type.Literal("agent-switched"),
  Type.Literal("model-switched"),
  Type.Literal("location-switched"),
]);

export const NativeSourceMessageSchema = Type.Object(
  {
    id: IdentifierSchema,
    type: NativeMessageTypeSchema,
    text: Type.String({ maxLength: MAX_MESSAGE_TEXT_CHARS * 2 }),
  },
  { additionalProperties: false },
);
export type NativeSourceMessage = Static<typeof NativeSourceMessageSchema>;

export const NativeSegmentCreateSchema = Type.Object(
  {
    source_id: SourceIdSchema,
    session_id: IdentifierSchema,
    ...NativeBoundaryProperties,
    projection_version: Type.Literal(3),
    processing_priority: Type.Integer({ minimum: 0, maximum: 100 }),
    messages: Type.Array(NativeSourceMessageSchema, {
      minItems: 1,
      maxItems: 10_000,
    }),
  },
  { additionalProperties: false },
);
export type NativeSegmentCreate = Static<typeof NativeSegmentCreateSchema>;

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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimProperty(value: unknown, property: string): unknown {
  const object = record(value);
  if (!object || typeof object[property] !== "string") {
    return value;
  }
  return { ...object, [property]: object[property].trim() };
}

function normalizeNativeSegmentCreate(value: unknown): unknown {
  let normalized = value;
  for (const property of [
    "source_id",
    "session_id",
    "start_source_message_id",
    "end_source_message_id",
  ]) {
    normalized = trimProperty(normalized, property);
  }
  const object = record(normalized);
  if (!object || !Array.isArray(object.messages)) {
    return normalized;
  }
  return {
    ...object,
    messages: object.messages.map((message) => trimProperty(message, "id")),
  };
}

function invalidNativeSegment(value: unknown): never {
  throw new ContractValidationError(
    "native segment request",
    NativeSegmentCreateSchema,
    value,
  );
}

export function parseNativeSegmentCreate(value: unknown): NativeSegmentCreate {
  const normalized = normalizeNativeSegmentCreate(value);
  const result = parse(
    "native segment request",
    NativeSegmentCreateSchema,
    normalized,
  );
  const ids = new Set<string>();
  for (const message of result.messages) {
    if (ids.has(message.id)) {
      return invalidNativeSegment(normalized);
    }
    ids.add(message.id);
    if (codePointLength(message.text) > MAX_MESSAGE_TEXT_CHARS) {
      return invalidNativeSegment(normalized);
    }
  }
  const first = result.messages[0];
  const last = result.messages.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    first.id !== result.start_source_message_id ||
    last.id !== result.end_source_message_id
  ) {
    return invalidNativeSegment(normalized);
  }
  const total = result.messages.reduce(
    (count, message) => count + codePointLength(message.text),
    0,
  );
  if (total > MAX_SEGMENT_TEXT_CHARS) {
    return invalidNativeSegment(normalized);
  }
  return result;
}

function utf8Frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function nativeSourceFingerprint(request: NativeSegmentCreate): string {
  const source =
    "reflection-source-v3:" +
    utf8Frame(request.source_id) +
    utf8Frame(request.session_id) +
    utf8Frame("3") +
    utf8Frame(request.start_source_message_id) +
    utf8Frame(request.end_source_message_id) +
    `${request.messages.length}:` +
    request.messages
      .map(
        (message) =>
          utf8Frame(message.id) +
          utf8Frame(message.type) +
          utf8Frame(message.text),
      )
      .join("");
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function nativeSegmentIdForRequest(
  request: NativeSegmentCreate,
  registry: SourceInfo,
): string {
  const parsedRequest = parseNativeSegmentCreate(request);
  const source = parseSourceInfo(registry);
  if (source.kind !== "opencode-v2" || source.identity_scheme !== "source-v1") {
    throw new Error(
      "native segment identity requires an opencode-v2 source-v1 registry entry",
    );
  }
  if (parsedRequest.source_id !== source.id) {
    throw new Error("segment request source does not match registered source");
  }
  return uuidv5(
    "reflection-source-segment-v1:" +
      utf8Frame(parsedRequest.source_id) +
      utf8Frame(parsedRequest.session_id) +
      utf8Frame("3") +
      utf8Frame(parsedRequest.start_source_message_id),
    SEGMENT_NAMESPACE,
  );
}

export function nativeProjectionFingerprint(
  segmentId: string,
  endSourceMessageId: string,
  summary: string,
  projectionVersion: number,
): string {
  const source =
    "reflection-projection-v3:" +
    utf8Frame(segmentId) +
    utf8Frame("3") +
    utf8Frame(endSourceMessageId) +
    utf8Frame(summary) +
    utf8Frame(String(projectionVersion));
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export const NativeJobResponseSchema = Type.Object(
  {
    source_id: SourceIdSchema,
    ...JobResponseMetadataProperties,
    ...NativeBoundaryProperties,
  },
  { additionalProperties: false },
);
export type NativeJobResponse = Static<typeof NativeJobResponseSchema>;

export const NativeSegmentResponseSchema = Type.Object(
  {
    source_id: SourceIdSchema,
    ...SegmentResponseMetadataProperties,
    ...NativeBoundaryProperties,
  },
  { additionalProperties: false },
);
export type NativeSegmentResponse = Static<typeof NativeSegmentResponseSchema>;

export const NativeSegmentSummarySchema = Type.Object(
  { ...SegmentSummaryMetadataProperties, ...NativeBoundaryProperties },
  { additionalProperties: false },
);
export type NativeSegmentSummary = Static<typeof NativeSegmentSummarySchema>;

export const NativeSegmentBoundarySchema = Type.Object(
  { ...SegmentBoundaryMetadataProperties, ...NativeBoundaryProperties },
  { additionalProperties: false },
);
export type NativeSegmentBoundary = Static<typeof NativeSegmentBoundarySchema>;

export const NativeSegmentTargetBoundarySchema = Type.Object(
  {
    ...SegmentTargetBoundaryMetadataProperties,
    ...NativeBoundaryProperties,
  },
  { additionalProperties: false },
);
export type NativeSegmentTargetBoundary = Static<
  typeof NativeSegmentTargetBoundarySchema
>;

export const NativeSessionSegmentsResponseSchema = Type.Object(
  {
    source_id: SourceIdSchema,
    manifest_version: Type.Literal(2),
    session_id: Type.String(),
    segments: Type.Array(NativeSegmentSummarySchema),
    boundaries: Type.Array(NativeSegmentBoundarySchema),
    targets: Type.Array(NativeSegmentTargetBoundarySchema),
  },
  { additionalProperties: false },
);
export type NativeSessionSegmentsResponse = Static<
  typeof NativeSessionSegmentsResponseSchema
>;

function normalizeNativeOwned(value: unknown): unknown {
  return trimProperty(value, "source_id");
}

function parseNativeOwned<T extends TSchema>(
  name: string,
  schema: T,
  value: unknown,
  expectedSourceId?: string,
): Static<T> {
  const result = parse(name, schema, normalizeNativeOwned(value));
  const owned = record(result);
  if (
    expectedSourceId !== undefined &&
    owned?.source_id !== parseSourceId(expectedSourceId, name)
  ) {
    throw new ContractValidationError(
      name,
      Type.Object({ source_id: Type.Literal(expectedSourceId) }),
      result,
    );
  }
  return result;
}

export function parseNativeJobResponse(
  value: unknown,
  expectedSourceId?: string,
): NativeJobResponse {
  return parseNativeOwned(
    "native job response",
    NativeJobResponseSchema,
    value,
    expectedSourceId,
  );
}

export function parseNativeSegmentResponse(
  value: unknown,
  expectedSourceId?: string,
): NativeSegmentResponse {
  const result = parseNativeOwned(
    "native segment response",
    NativeSegmentResponseSchema,
    value,
    expectedSourceId,
  );
  result.claims.forEach(validateClaimObject);
  return result;
}

export function parseNativeSegmentSummary(
  value: unknown,
): NativeSegmentSummary {
  return parse("native segment summary", NativeSegmentSummarySchema, value);
}

export function parseNativeSegmentBoundary(
  value: unknown,
): NativeSegmentBoundary {
  return parse("native segment boundary", NativeSegmentBoundarySchema, value);
}

export function parseNativeSegmentTargetBoundary(
  value: unknown,
): NativeSegmentTargetBoundary {
  return parse(
    "native segment target boundary",
    NativeSegmentTargetBoundarySchema,
    value,
  );
}

export function parseNativeSessionSegmentsResponse(
  value: unknown,
  expectedSourceId?: string,
): NativeSessionSegmentsResponse {
  return parseNativeOwned(
    "native session segments response",
    NativeSessionSegmentsResponseSchema,
    value,
    expectedSourceId,
  );
}

export { ClaimDataSchema };
