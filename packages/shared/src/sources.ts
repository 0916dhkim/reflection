import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { v5 as uuidv5 } from "uuid";

import {
  ContractValidationError,
  type JobResponse,
  type SegmentCreate,
  type SegmentResponse,
  type SessionSegmentsResponse,
  parseJobResponse,
  parseSegmentCreate,
  parseSegmentResponse,
  parseSessionSegmentsResponse,
} from "./contracts.js";
import { SEGMENT_NAMESPACE, segmentIdForRequest } from "./domain.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const SourceIdSchema = Type.String({
  minLength: 1,
  maxLength: 500,
  pattern: ".*\\S.*",
});
const IdentifierSchema = Type.String({ minLength: 1, maxLength: 500 });
const UuidSchema = Type.String({ pattern: UUID_PATTERN });
const DateTimeSchema = Type.String();
const Nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const SourceBoundaryV1Properties = {
  source_boundary_version: Type.Literal(1),
  start_source_message_id: Type.Null(),
  end_source_message_id: Type.Null(),
} as const;
const SourceBoundaryV2Properties = {
  source_boundary_version: Type.Literal(2),
  start_source_message_id: IdentifierSchema,
  end_source_message_id: IdentifierSchema,
} as const;

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

function hasOwn(value: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function parseSourceId(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : value;
  return parse(name, SourceIdSchema, normalized);
}

function withSourceId(
  value: unknown,
  name: string,
): Record<string, unknown> & { source_id: string } {
  const object = record(value);
  if (!object || !hasOwn(object, "source_id")) {
    throw new ContractValidationError(name, SourceIdSchema, value);
  }
  return { ...object, source_id: parseSourceId(object.source_id, name) };
}

function withoutSourceId(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { source_id: _sourceId, ...legacy } = value;
  return legacy;
}

function utf8Frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export const SourceInfoSchema = Type.Object(
  {
    id: SourceIdSchema,
    kind: Type.Union([
      Type.Literal("opencode-v1"),
      Type.Literal("opencode-v2"),
    ]),
    identity_scheme: Type.Union([
      Type.Literal("legacy"),
      Type.Literal("source-v1"),
    ]),
  },
  { additionalProperties: false },
);
export type SourceInfo = Static<typeof SourceInfoSchema>;

export function parseSourceInfo(value: unknown): SourceInfo {
  const object = record(value);
  const normalized = object
    ? { ...object, id: parseSourceId(object.id, "source") }
    : value;
  return parse("source", SourceInfoSchema, normalized);
}

export interface SourceSession {
  sourceId: string;
  sessionId: string;
}

export function sourceSessionKey({
  sourceId,
  sessionId,
}: SourceSession): string {
  return JSON.stringify([sourceId, sessionId]);
}

const SourceMessageSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String({ maxLength: 2_000_000 }),
  },
  { additionalProperties: false },
);
const SegmentCreateCommonProperties = {
  source_id: SourceIdSchema,
  session_id: IdentifierSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Optional(
    Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
  ),
  processing_priority: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 100 }),
  ),
  messages: Type.Array(SourceMessageSchema, { minItems: 1, maxItems: 10_000 }),
} as const;

export const SourceSegmentCreateSchema = Type.Union([
  Type.Object(SegmentCreateCommonProperties, { additionalProperties: false }),
  Type.Object(
    { ...SegmentCreateCommonProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentCreateCommonProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type SourceSegmentCreate = SegmentCreate & { source_id: string };

export function parseSourceSegmentCreate(value: unknown): SourceSegmentCreate {
  const transport = withSourceId(value, "source segment request");
  const result = {
    ...parseSegmentCreate(withoutSourceId(transport)),
    source_id: transport.source_id,
  };
  parse("source segment request", SourceSegmentCreateSchema, result);
  return result;
}

export function decodePersistedSegment(
  value: unknown,
  assignedSourceId: string,
): SourceSegmentCreate {
  const sourceId = parseSourceId(assignedSourceId, "assigned source");
  const object = record(value);
  if (!object) {
    return { ...parseSegmentCreate(value), source_id: sourceId };
  }
  if (!hasOwn(object, "source_id")) {
    return { ...parseSegmentCreate(object), source_id: sourceId };
  }
  const persistedSourceId = parseSourceId(
    object.source_id,
    "persisted segment source",
  );
  if (persistedSourceId !== sourceId) {
    throw new ContractValidationError(
      "persisted segment source",
      Type.Object({ source_id: Type.Literal(sourceId) }),
      object,
    );
  }
  return {
    ...parseSegmentCreate(withoutSourceId(object)),
    source_id: sourceId,
  };
}

export function sourceSegmentIdForRequest(
  request: Pick<
    SourceSegmentCreate,
    | "source_id"
    | "session_id"
    | "source_boundary_version"
    | "start_user_message_id"
    | "start_source_message_id"
  >,
  source: SourceInfo,
): string {
  const parsedSource = parseSourceInfo(source);
  const requestSourceId = parseSourceId(
    request.source_id,
    "segment request source",
  );
  if (requestSourceId !== parsedSource.id) {
    throw new Error("segment request source does not match registered source");
  }
  if (parsedSource.identity_scheme === "legacy") {
    return segmentIdForRequest(request);
  }
  const startCursor =
    request.source_boundary_version === 1
      ? request.start_user_message_id
      : request.start_source_message_id;
  if (startCursor === null) {
    throw new Error("V2 segment identity requires a start source cursor");
  }
  return uuidv5(
    "reflection-source-segment-v1:" +
      utf8Frame(requestSourceId) +
      utf8Frame(request.session_id) +
      utf8Frame(String(request.source_boundary_version)) +
      utf8Frame(startCursor),
    SEGMENT_NAMESPACE,
  );
}

const JobResponseProperties = {
  source_id: SourceIdSchema,
  id: Type.Integer(),
  segment_id: UuidSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  source_fingerprint: Nullable(Type.String()),
  projection_version: Type.Integer(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("superseded"),
  ]),
  attempts: Type.Integer(),
  error: Nullable(Type.String()),
  created_at: DateTimeSchema,
  started_at: Nullable(DateTimeSchema),
  finished_at: Nullable(DateTimeSchema),
  next_attempt_at: DateTimeSchema,
} as const;
const SegmentResponseProperties = {
  source_id: SourceIdSchema,
  id: UuidSchema,
  session_id: IdentifierSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  summary: Type.String(),
  claims: Type.Array(
    Type.Object(
      {
        subject: Type.String(),
        subject_entity_id: UuidSchema,
        predicate: Type.String(),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        object_entity: Nullable(Type.String()),
        object_entity_id: Nullable(UuidSchema),
        object_value: Nullable(Type.String()),
      },
      { additionalProperties: false },
    ),
  ),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
} as const;
const SegmentSummaryProperties = {
  id: UuidSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Integer(),
  summary: Type.String(),
} as const;
const SegmentBoundaryProperties = {
  id: UuidSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Integer(),
  source_eligible: Type.Boolean(),
  source_fingerprint: Nullable(Type.String()),
} as const;
const SegmentTargetBoundaryProperties = {
  id: UuidSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Integer(),
  status: JobResponseProperties.status,
  source_fingerprint: Type.String(),
} as const;
const SegmentSummarySchema = Type.Union([
  Type.Object(
    { ...SegmentSummaryProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentSummaryProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
const SegmentBoundarySchema = Type.Union([
  Type.Object(
    { ...SegmentBoundaryProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentBoundaryProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
const SegmentTargetBoundarySchema = Type.Union([
  Type.Object(
    { ...SegmentTargetBoundaryProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentTargetBoundaryProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);

export const SourceJobResponseSchema = Type.Union([
  Type.Object(
    { ...JobResponseProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...JobResponseProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type SourceJobResponse = JobResponse & { source_id: string };

export const SourceSegmentResponseSchema = Type.Union([
  Type.Object(
    { ...SegmentResponseProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentResponseProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type SourceSegmentResponse = SegmentResponse & { source_id: string };

export const SourceSessionSegmentsResponseSchema = Type.Object(
  {
    source_id: SourceIdSchema,
    manifest_version: Type.Literal(2),
    session_id: Type.String(),
    segments: Type.Array(SegmentSummarySchema),
    boundaries: Type.Array(SegmentBoundarySchema),
    targets: Type.Array(SegmentTargetBoundarySchema),
  },
  { additionalProperties: false },
);
export type SourceSessionSegmentsResponse = SessionSegmentsResponse & {
  source_id: string;
};

function parseOwnedResponse<T>(
  name: string,
  schema: TSchema,
  value: unknown,
  expectedSourceId: string | undefined,
  parseLegacy: (legacy: Record<string, unknown>) => T,
): T & { source_id: string } {
  const transport = withSourceId(value, name);
  parse(name, schema, transport);
  const sourceId = transport.source_id;
  if (
    expectedSourceId !== undefined &&
    sourceId !== parseSourceId(expectedSourceId, name)
  ) {
    throw new ContractValidationError(
      name,
      Type.Object({ source_id: Type.Literal(expectedSourceId) }),
      transport,
    );
  }
  return { ...parseLegacy(withoutSourceId(transport)), source_id: sourceId };
}

export function parseSourceJobResponse(
  value: unknown,
  expectedSourceId?: string,
): SourceJobResponse {
  return parseOwnedResponse(
    "source job response",
    SourceJobResponseSchema,
    value,
    expectedSourceId,
    parseJobResponse,
  );
}

export function parseSourceSegmentResponse(
  value: unknown,
  expectedSourceId?: string,
): SourceSegmentResponse {
  return parseOwnedResponse(
    "source segment response",
    SourceSegmentResponseSchema,
    value,
    expectedSourceId,
    parseSegmentResponse,
  );
}

export function parseSourceSessionSegmentsResponse(
  value: unknown,
  expectedSourceId?: string,
): SourceSessionSegmentsResponse {
  return parseOwnedResponse(
    "source session segments response",
    SourceSessionSegmentsResponseSchema,
    value,
    expectedSourceId,
    parseSessionSegmentsResponse,
  );
}
