import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  parseExtractionResult,
  parseExtractionWireResult,
  parseJobResponse,
  parseResolutionResult,
  parseSearchRequest,
  parseSegmentCreate,
  parseSegmentResponse,
  parseSessionSegmentsResponse,
  toExtractionResult,
} from "../src/contracts.js";

const SEGMENT_ID = "11111111-1111-4111-8111-111111111111";
const ENTITY_ID = "22222222-2222-4222-8222-222222222222";

describe("public contracts", () => {
  it("normalizes legacy requests without changing source text", () => {
    expect(
      parseSegmentCreate({
        session_id: " session ",
        start_user_message_id: " start ",
        end_user_message_id: " end ",
        messages: [{ role: "user", text: "" }],
      }),
    ).toEqual({
      session_id: "session",
      start_user_message_id: "start",
      end_user_message_id: "end",
      projection_version: 0,
      processing_priority: 0,
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
      messages: [{ role: "user", text: "" }],
    });
  });

  it("accepts only canonical V1 and single-turn V2 source boundaries", () => {
    expect(
      parseSegmentCreate({
        session_id: " session ",
        start_user_message_id: " turn ",
        end_user_message_id: " turn ",
        source_boundary_version: 2,
        start_source_message_id: " user ",
        end_source_message_id: " assistant ",
        processing_priority: 100,
        messages: [{ role: "user", text: "source" }],
      }),
    ).toMatchObject({
      session_id: "session",
      start_user_message_id: "turn",
      end_user_message_id: "turn",
      source_boundary_version: 2,
      start_source_message_id: "user",
      end_source_message_id: "assistant",
      processing_priority: 100,
    });

    const base = {
      session_id: "session",
      start_user_message_id: "start",
      end_user_message_id: "start",
      messages: [{ role: "user", text: "source" }],
    };
    for (const malformed of [
      { ...base, start_source_message_id: "user" },
      {
        ...base,
        source_boundary_version: 1,
        start_source_message_id: "user",
      },
      {
        ...base,
        source_boundary_version: 2,
        start_source_message_id: "user",
      },
      {
        ...base,
        source_boundary_version: 2,
        start_source_message_id: " ",
        end_source_message_id: "assistant",
      },
      {
        ...base,
        end_user_message_id: "different",
        source_boundary_version: 2,
        start_source_message_id: "user",
        end_source_message_id: "assistant",
      },
      { ...base, processing_priority: -1 },
      { ...base, processing_priority: 101 },
      { ...base, processing_priority: 1.5 },
    ]) {
      expect(() => parseSegmentCreate(malformed)).toThrow(
        ContractValidationError,
      );
    }
  });

  it("rejects extra fields and trims search queries", () => {
    expect(parseSearchRequest({ query: " memory " })).toEqual({
      query: "memory",
    });
    expect(() => parseSearchRequest({ query: "memory", extra: true })).toThrow(
      ContractValidationError,
    );
  });
});

describe("response contracts", () => {
  const job = {
    id: 1,
    segment_id: SEGMENT_ID,
    start_user_message_id: "turn",
    end_user_message_id: "turn",
    source_boundary_version: 2,
    start_source_message_id: "user",
    end_source_message_id: "assistant",
    source_fingerprint: null,
    projection_version: 1,
    status: "pending",
    attempts: 0,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    started_at: null,
    finished_at: null,
    next_attempt_at: "2026-01-01T00:00:00Z",
  } as const;

  it("strictly parses jobs and committed segments", () => {
    expect(parseJobResponse(job)).toEqual(job);
    expect(() =>
      parseJobResponse({ ...job, end_user_message_id: "other" }),
    ).toThrow(ContractValidationError);
    expect(() => {
      const { end_source_message_id: _end, ...missing } = job;
      parseJobResponse(missing);
    }).toThrow(ContractValidationError);

    const segment = {
      id: SEGMENT_ID,
      session_id: "session",
      start_user_message_id: "start",
      end_user_message_id: "end",
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
      summary: "summary",
      claims: [
        {
          subject: "Reflection",
          subject_entity_id: ENTITY_ID,
          predicate: "uses",
          confidence: 0.9,
          object_entity: null,
          object_entity_id: null,
          object_value: "PostgreSQL",
        },
      ],
      created_at: "created",
      updated_at: "updated",
    } as const;
    expect(parseSegmentResponse(segment)).toEqual(segment);
    expect(() =>
      parseSegmentResponse({
        ...segment,
        claims: [
          {
            ...segment.claims[0],
            object_entity: "PostgreSQL",
            object_entity_id: ENTITY_ID,
          },
        ],
      }),
    ).toThrow("exactly one");
  });

  it("requires manifest version 2 and explicit mixed boundary versions", () => {
    const manifest = {
      manifest_version: 2,
      session_id: "session",
      segments: [
        {
          id: SEGMENT_ID,
          start_user_message_id: "u1",
          end_user_message_id: "u2",
          source_boundary_version: 1,
          start_source_message_id: null,
          end_source_message_id: null,
          projection_version: 1,
          summary: "summary",
        },
      ],
      boundaries: [
        {
          id: SEGMENT_ID,
          start_user_message_id: "u3",
          end_user_message_id: "u3",
          source_boundary_version: 2,
          start_source_message_id: "u3",
          end_source_message_id: "a3",
          projection_version: 1,
          source_eligible: true,
          source_fingerprint: "fingerprint",
        },
      ],
      targets: [
        {
          id: ENTITY_ID,
          start_user_message_id: "u4",
          end_user_message_id: "u4",
          source_boundary_version: 2,
          start_source_message_id: "u4",
          end_source_message_id: "a4",
          projection_version: 1,
          status: "running",
          source_fingerprint: "target fingerprint",
        },
      ],
    } as const;
    expect(parseSessionSegmentsResponse(manifest)).toEqual(manifest);
    expect(() =>
      parseSessionSegmentsResponse({ ...manifest, manifest_version: 1 }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseSessionSegmentsResponse({
        ...manifest,
        boundaries: [
          {
            ...manifest.boundaries[0],
            start_source_message_id: null,
          },
        ],
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseSessionSegmentsResponse({ ...manifest, extra: true }),
    ).toThrow(ContractValidationError);
  });
});

describe("model contracts", () => {
  it("strictly parses durable normalized extraction results", () => {
    const result = {
      summary: "Useful summary",
      claims: [
        {
          subject: "Reflection",
          predicate: "uses database",
          confidence: 0.9,
          object_entity: "PostgreSQL",
          object_value: null,
        },
        {
          subject: "Reflection",
          predicate: "has timeout",
          confidence: 0.8,
          object_entity: null,
          object_value: "120 seconds",
        },
      ],
    } as const;
    expect(parseExtractionResult(result)).toEqual(result);
    for (const malformedClaim of [
      { ...result.claims[0], object_value: "also literal" },
      { ...result.claims[0], object_entity: null },
      { ...result.claims[0], extra: true },
    ]) {
      expect(() =>
        parseExtractionResult({ summary: "summary", claims: [malformedClaim] }),
      ).toThrow(ContractValidationError);
    }
  });

  it("uses a tagged object and normalizes machine predicates losslessly", () => {
    const wire = parseExtractionWireResult({
      summary: " Useful summary ",
      claims: [
        {
          subject: " Reflection ",
          predicate: "has_storageBackend",
          confidence: 0.9,
          object_kind: "entity",
          object_text: "PostgreSQL",
        },
        {
          subject: "Reflection",
          predicate: "has timeout",
          confidence: 0.8,
          object_kind: "literal",
          object_text: " 120 seconds ",
        },
      ],
    });
    expect(toExtractionResult(wire)).toEqual({
      summary: "Useful summary",
      claims: [
        {
          subject: "Reflection",
          predicate: "has storage backend",
          confidence: 0.9,
          object_entity: "PostgreSQL",
          object_value: null,
        },
        {
          subject: "Reflection",
          predicate: "has timeout",
          confidence: 0.8,
          object_entity: null,
          object_value: " 120 seconds ",
        },
      ],
    });
  });

  it("enforces claim action and reason agreement", () => {
    expect(() =>
      parseResolutionResult({
        claims: [{ claim_id: "c0", action: "keep", reason: "unstable_scope" }],
        resolutions: [],
      }),
    ).toThrow("does not match");
  });
});
