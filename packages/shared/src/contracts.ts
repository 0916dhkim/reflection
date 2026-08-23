import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const MAX_MESSAGE_TEXT_CHARS = 1_000_000;
export const MAX_SEGMENT_TEXT_CHARS = 2_000_000;
export const PROJECTION_SAFE_VERSION = 1;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export class ContractValidationError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(name: string, schema: TSchema, value: unknown) {
    const issues = [...Value.Errors(schema, value)].map((error) => ({
      path: error.path,
      message: error.message,
    }));
    super(`invalid ${name}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

function parse<T extends TSchema>(
  name: string,
  schema: T,
  value: unknown,
): Static<T> {
  if (!Value.Check(schema, value))
    throw new ContractValidationError(name, schema, value);
  return value as Static<T>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimProperty(value: unknown, property: string): unknown {
  const object = record(value);
  if (!object || typeof object[property] !== "string") return value;
  return { ...object, [property]: object[property].trim() };
}

function codePointLength(value: string): number {
  return [...value].length;
}

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

export const SourceBoundarySchema = Type.Union([
  Type.Object(SourceBoundaryV1Properties, { additionalProperties: false }),
  Type.Object(SourceBoundaryV2Properties, { additionalProperties: false }),
]);
export type SourceBoundary = Static<typeof SourceBoundarySchema>;
export type SourceBoundaryVersion = SourceBoundary["source_boundary_version"];

function validateSourceBoundaryUsers<
  T extends SourceBoundary & {
    start_user_message_id: string;
    end_user_message_id: string;
  },
>(name: string, value: T): T {
  if (
    value.source_boundary_version === 2 &&
    value.start_user_message_id !== value.end_user_message_id
  ) {
    throw new ContractValidationError(name, Type.Never(), value);
  }
  return value;
}

export const SourceMessageSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String({ maxLength: MAX_MESSAGE_TEXT_CHARS }),
  },
  { additionalProperties: false },
);
export type SourceMessage = Static<typeof SourceMessageSchema>;

const SegmentCreateInputProperties = {
  session_id: IdentifierSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Optional(
    Type.Union([Type.Literal(0), Type.Literal(1)]),
  ),
  processing_priority: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 100 }),
  ),
  source_boundary_version: Type.Optional(
    Type.Union([Type.Literal(1), Type.Literal(2)]),
  ),
  start_source_message_id: Type.Optional(Nullable(IdentifierSchema)),
  end_source_message_id: Type.Optional(Nullable(IdentifierSchema)),
  messages: Type.Array(SourceMessageSchema, {
    minItems: 1,
    maxItems: 10_000,
  }),
} as const;

// The HTTP schema accepts legacy requests; parseSegmentCreate returns only the
// explicit canonical union below.
export const SegmentCreateSchema = Type.Object(SegmentCreateInputProperties, {
  additionalProperties: false,
});

const CanonicalSegmentCreateProperties = {
  session_id: IdentifierSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Union([Type.Literal(0), Type.Literal(1)]),
  processing_priority: Type.Integer({ minimum: 0, maximum: 100 }),
  messages: Type.Array(SourceMessageSchema, {
    minItems: 1,
    maxItems: 10_000,
  }),
} as const;

const CanonicalSegmentCreateSchema = Type.Union([
  Type.Object(
    { ...CanonicalSegmentCreateProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CanonicalSegmentCreateProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type SegmentCreate = Static<typeof CanonicalSegmentCreateSchema>;

function hasOwn(value: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

export function parseSegmentCreate(value: unknown): SegmentCreate {
  let normalized: unknown = value;
  for (const property of [
    "session_id",
    "start_user_message_id",
    "end_user_message_id",
    "start_source_message_id",
    "end_source_message_id",
  ]) {
    normalized = trimProperty(normalized, property);
  }

  let object = record(normalized);
  if (object) {
    const sourceObject = object;
    const hasAnySourceField = [
      "source_boundary_version",
      "start_source_message_id",
      "end_source_message_id",
    ].some((property) => hasOwn(sourceObject, property));
    if (!hasAnySourceField) {
      normalized = {
        ...object,
        source_boundary_version: 1,
        start_source_message_id: null,
        end_source_message_id: null,
      };
    } else if (object.source_boundary_version === 1) {
      normalized = {
        ...object,
        start_source_message_id: object.start_source_message_id ?? null,
        end_source_message_id: object.end_source_message_id ?? null,
      };
    }
  }

  object = record(normalized);
  if (object && object.projection_version === undefined) {
    normalized = { ...object, projection_version: 0 };
  } else if (
    object &&
    (object.projection_version === true || object.projection_version === false)
  ) {
    normalized = {
      ...object,
      projection_version: Number(object.projection_version),
    };
  }

  object = record(normalized);
  if (object && object.processing_priority === undefined) {
    normalized = { ...object, processing_priority: 0 };
  }
  const result = parse(
    "segment request",
    CanonicalSegmentCreateSchema,
    normalized,
  );
  if (
    result.source_boundary_version === 2 &&
    result.start_user_message_id !== result.end_user_message_id
  ) {
    throw new ContractValidationError(
      "segment request",
      Type.Never(),
      normalized,
    );
  }
  const aggregate = result.messages.reduce(
    (total, message) => total + codePointLength(message.text),
    0,
  );
  if (aggregate > MAX_SEGMENT_TEXT_CHARS) {
    throw new ContractValidationError("segment request", SegmentCreateSchema, {
      ...(record(normalized) ?? {}),
      messages: "combined message text exceeds limit",
    });
  }
  return result;
}

export const JobStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
]);
export type JobStatus = Static<typeof JobStatusSchema>;

const JobResponseProperties = {
  id: Type.Integer(),
  segment_id: UuidSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  source_fingerprint: Nullable(Type.String()),
  projection_version: Type.Integer(),
  status: JobStatusSchema,
  attempts: Type.Integer(),
  error: Nullable(Type.String()),
  created_at: DateTimeSchema,
  started_at: Nullable(DateTimeSchema),
  finished_at: Nullable(DateTimeSchema),
  next_attempt_at: DateTimeSchema,
} as const;

export const JobResponseSchema = Type.Union([
  Type.Object(
    { ...JobResponseProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...JobResponseProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type JobResponse = Static<typeof JobResponseSchema>;

export function parseJobResponse(value: unknown): JobResponse {
  return validateSourceBoundaryUsers(
    "job response",
    parse("job response", JobResponseSchema, value),
  );
}

export const ClaimDataSchema = Type.Object(
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
);
export type ClaimData = Static<typeof ClaimDataSchema>;

export function validateClaimObject(claim: ClaimData): ClaimData {
  const hasEntity =
    claim.object_entity !== null && claim.object_entity_id !== null;
  const hasPartialEntity =
    (claim.object_entity === null) !== (claim.object_entity_id === null);
  const hasLiteral = claim.object_value !== null;
  if (hasPartialEntity || hasEntity === hasLiteral) {
    throw new Error(
      "claim must have exactly one complete entity object or literal value",
    );
  }
  return claim;
}

const SegmentResponseProperties = {
  id: UuidSchema,
  session_id: IdentifierSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  summary: Type.String(),
  claims: Type.Array(ClaimDataSchema),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
} as const;

export const SegmentResponseSchema = Type.Union([
  Type.Object(
    { ...SegmentResponseProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentResponseProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type SegmentResponse = Static<typeof SegmentResponseSchema>;

export function parseSegmentResponse(value: unknown): SegmentResponse {
  const result = validateSourceBoundaryUsers(
    "segment response",
    parse("segment response", SegmentResponseSchema, value),
  );
  result.claims.forEach(validateClaimObject);
  return result;
}

const SegmentSummaryProperties = {
  id: UuidSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Integer(),
  summary: Type.String(),
} as const;

export const SegmentSummarySchema = Type.Union([
  Type.Object(
    { ...SegmentSummaryProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentSummaryProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type SegmentSummary = Static<typeof SegmentSummarySchema>;

const SegmentBoundaryProperties = {
  id: UuidSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Integer(),
  source_eligible: Type.Boolean(),
  source_fingerprint: Nullable(Type.String()),
} as const;

export const SegmentBoundarySchema = Type.Union([
  Type.Object(
    { ...SegmentBoundaryProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentBoundaryProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type SegmentBoundary = Static<typeof SegmentBoundarySchema>;

const SegmentTargetBoundaryProperties = {
  id: UuidSchema,
  start_user_message_id: IdentifierSchema,
  end_user_message_id: IdentifierSchema,
  projection_version: Type.Integer(),
  status: JobStatusSchema,
  source_fingerprint: Type.String(),
} as const;

export const SegmentTargetBoundarySchema = Type.Union([
  Type.Object(
    { ...SegmentTargetBoundaryProperties, ...SourceBoundaryV1Properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...SegmentTargetBoundaryProperties, ...SourceBoundaryV2Properties },
    { additionalProperties: false },
  ),
]);
export type SegmentTargetBoundary = Static<typeof SegmentTargetBoundarySchema>;

export const SessionSegmentsResponseSchema = Type.Object(
  {
    manifest_version: Type.Literal(2),
    session_id: Type.String(),
    segments: Type.Array(SegmentSummarySchema),
    boundaries: Type.Array(SegmentBoundarySchema),
    targets: Type.Array(SegmentTargetBoundarySchema),
  },
  { additionalProperties: false },
);
export type SessionSegmentsResponse = Static<
  typeof SessionSegmentsResponseSchema
>;

export function parseSessionSegmentsResponse(
  value: unknown,
): SessionSegmentsResponse {
  const result = parse(
    "session segments response",
    SessionSegmentsResponseSchema,
    value,
  );
  for (const boundary of [
    ...result.segments,
    ...result.boundaries,
    ...result.targets,
  ]) {
    validateSourceBoundaryUsers("session segments response", boundary);
  }
  return result;
}

export const SearchRequestSchema = Type.Object(
  { query: Type.String({ minLength: 1, maxLength: 10_000 }) },
  { additionalProperties: false },
);
export type SearchRequest = Static<typeof SearchRequestSchema>;

export function parseSearchRequest(value: unknown): SearchRequest {
  return parse(
    "search request",
    SearchRequestSchema,
    trimProperty(value, "query"),
  );
}

export const SearchClaimSchema = Type.Composite([
  ClaimDataSchema,
  Type.Object({
    segment_ids: Type.Array(UuidSchema),
    support_count: Type.Integer(),
    session_count: Type.Integer(),
    score: Type.Number(),
  }),
]);
export type SearchClaim = Static<typeof SearchClaimSchema>;

export const SearchResponseSchema = Type.Object(
  { claims: Type.Array(SearchClaimSchema) },
  { additionalProperties: false },
);
export type SearchResponse = Static<typeof SearchResponseSchema>;

const EntityMentionSchema = Type.String({
  minLength: 1,
  maxLength: 500,
  description:
    "Self-contained entity name with enough owner or product context to identify it outside this source, such as 'Ideogram Pro plan' rather than 'Pro plan'.",
});
const NaturalPredicateSchema = Type.String({
  minLength: 1,
  maxLength: 500,
  pattern: "^[^_]+$",
  description:
    "Short user-facing natural-language verb phrase stored and displayed verbatim. Use lowercase words with spaces, never snake_case, camelCase, or database identifiers.",
});
const ShortTextSchema = Type.String({ minLength: 1, maxLength: 500 });
const DescriptionSchema = Type.String({ minLength: 1, maxLength: 1000 });
const LiteralTextSchema = Type.String({ minLength: 1, maxLength: 10_000 });

const ExtractedClaimProperties = {
  subject: EntityMentionSchema,
  predicate: NaturalPredicateSchema,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
} as const;

export const ExtractedClaimSchema = Type.Union([
  Type.Object(
    {
      ...ExtractedClaimProperties,
      object_entity: EntityMentionSchema,
      object_value: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ExtractedClaimProperties,
      object_entity: Type.Null(),
      object_value: LiteralTextSchema,
    },
    { additionalProperties: false },
  ),
]);
export type ExtractedClaim = Static<typeof ExtractedClaimSchema>;

export const ExtractionResultSchema = Type.Object(
  {
    summary: Type.String({ maxLength: 1000 }),
    claims: Type.Array(ExtractedClaimSchema, { maxItems: 25 }),
  },
  { additionalProperties: false },
);
export type ExtractionResult = Static<typeof ExtractionResultSchema>;

export function parseExtractionResult(value: unknown): ExtractionResult {
  const result = parse(
    "normalized extraction result",
    ExtractionResultSchema,
    value,
  );
  if (result.claims.some((claim) => /[a-z][A-Z]/.test(claim.predicate))) {
    throw new ContractValidationError(
      "normalized extraction result",
      Type.Never(),
      value,
    );
  }
  return result;
}

export const ExtractionWireClaimSchema = Type.Object(
  {
    subject: EntityMentionSchema,
    predicate: ShortTextSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    object_kind: Type.Union([Type.Literal("entity"), Type.Literal("literal")]),
    object_text: LiteralTextSchema,
  },
  { additionalProperties: false },
);
export type ExtractionWireClaim = Static<typeof ExtractionWireClaimSchema>;

export const ExtractionWireResultSchema = Type.Object(
  {
    summary: Type.String({ maxLength: 1000 }),
    claims: Type.Array(ExtractionWireClaimSchema, { maxItems: 25 }),
  },
  { additionalProperties: false },
);
export type ExtractionWireResult = Static<typeof ExtractionWireResultSchema>;

function normalizePredicate(predicate: string): string {
  return predicate
    .replaceAll("_", " ")
    .replace(/([A-Z]{3,})([A-Z][a-z]{2,})/g, "$1 $2")
    .replace(/(?<=[a-z])(?=[A-Z])/g, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .join(" ");
}

export function parseExtractionWireResult(
  value: unknown,
): ExtractionWireResult {
  const object = record(value);
  const normalized = object
    ? {
        ...object,
        summary:
          typeof object.summary === "string"
            ? object.summary.trim()
            : object.summary,
        claims: Array.isArray(object.claims)
          ? object.claims.map((claim) => {
              let current: unknown = claim;
              current = trimProperty(current, "subject");
              current = trimProperty(current, "predicate");
              return current;
            })
          : object.claims,
      }
    : value;
  return parse("extraction result", ExtractionWireResultSchema, normalized);
}

export function toExtractionResult(
  value: ExtractionWireResult,
): ExtractionResult {
  const claims = value.claims.map((claim) => {
    const common = {
      subject: claim.subject.trim(),
      predicate: normalizePredicate(claim.predicate),
      confidence: claim.confidence,
    };
    const normalized =
      claim.object_kind === "entity"
        ? {
            ...common,
            object_entity: claim.object_text.trim(),
            object_value: null,
          }
        : {
            ...common,
            object_entity: null,
            object_value: claim.object_text,
          };
    const result = parse("extracted claim", ExtractedClaimSchema, normalized);
    if (/[a-z][A-Z]/.test(result.predicate)) {
      throw new Error(
        "predicate must use natural-language words separated by spaces",
      );
    }
    return result;
  });
  return parseExtractionResult({ summary: value.summary.trim(), claims });
}

export const ClaimDecisionSchema = Type.Object(
  {
    claim_id: Type.String({ pattern: "^c[0-9]+$" }),
    action: Type.Union([
      Type.Literal("keep"),
      Type.Literal("drop"),
      Type.Literal("review"),
    ]),
    reason: Type.Union([
      Type.Literal("supported"),
      Type.Literal("unstable_scope"),
      Type.Literal("lifecycle_mismatch"),
      Type.Literal("unsupported"),
      Type.Literal("transient"),
    ]),
  },
  { additionalProperties: false },
);
export type ClaimDecision = Static<typeof ClaimDecisionSchema>;

export const ResolutionSchema = Type.Object(
  {
    mention_id: Type.String(),
    candidate_entity_id: Type.Union([UuidSchema, Type.Null()], {
      description:
        "Exact ID copied from this mention's supplied candidates, or null when creating a new entity. Always null when the candidate list is empty; never invent an ID.",
    }),
    canonical_name: ShortTextSchema,
    description: DescriptionSchema,
    aliases: Type.Array(ShortTextSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type Resolution = Static<typeof ResolutionSchema>;

export const ResolutionResultSchema = Type.Object(
  {
    claims: Type.Array(ClaimDecisionSchema, { maxItems: 25 }),
    resolutions: Type.Array(ResolutionSchema, { maxItems: 1000 }),
  },
  { additionalProperties: false },
);
export type ResolutionResult = Static<typeof ResolutionResultSchema>;

export function parseResolutionResult(value: unknown): ResolutionResult {
  const object = record(value);
  const normalized = object
    ? {
        ...object,
        resolutions: Array.isArray(object.resolutions)
          ? object.resolutions.map((resolution) => {
              let current: unknown = resolution;
              for (const property of ["canonical_name", "description"]) {
                current = trimProperty(current, property);
              }
              const item = record(current);
              return item && Array.isArray(item.aliases)
                ? {
                    ...item,
                    aliases: item.aliases.map((alias) =>
                      typeof alias === "string" ? alias.trim() : alias,
                    ),
                  }
                : current;
            })
          : object.resolutions,
      }
    : value;
  const result = parse("resolution result", ResolutionResultSchema, normalized);
  for (const decision of result.claims) {
    const expected =
      decision.reason === "supported"
        ? "keep"
        : decision.reason === "unstable_scope"
          ? "review"
          : "drop";
    if (decision.action !== expected)
      throw new Error("claim action does not match its reason");
  }
  return result;
}
