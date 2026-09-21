import { describe, expect, it } from "vitest";

import { parseSegmentCreate } from "../src/contracts.js";
import { segmentIdForRequest, sourceFingerprint } from "../src/domain.js";
import {
  type SourceInfo,
  type SourceSegmentCreate,
  decodePersistedSegment,
  parseSourceInfo,
  parseSourceJobResponse,
  parseSourceSegmentCreate,
  parseSourceSegmentResponse,
  parseSourceSessionSegmentsResponse,
  sourceSegmentIdForRequest,
  sourceSessionKey,
} from "../src/sources.js";

const SEGMENT_ID = "11111111-1111-4111-8111-111111111111";
const ENTITY_ID = "22222222-2222-4222-8222-222222222222";

const sourceV1: SourceInfo = {
  id: "source-a",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
};
const legacySource: SourceInfo = {
  id: "legacy-source",
  kind: "opencode-v1",
  identity_scheme: "legacy",
};
const request = {
  source_id: "source-a",
  session_id: "session",
  start_user_message_id: "turn",
  end_user_message_id: "turn",
  source_boundary_version: 2 as const,
  start_source_message_id: "message-a",
  end_source_message_id: "message-b",
  projection_version: 0 as const,
  processing_priority: 0,
  messages: [{ role: "user" as const, text: "source" }],
};

describe("source ownership contracts", () => {
  it("trims source information and creates collision-proof source session keys", () => {
    expect(
      parseSourceInfo({
        ...sourceV1,
        id: " source-a ",
      }),
    ).toEqual(sourceV1);
    expect(sourceSessionKey({ sourceId: "a", sessionId: "bc" })).not.toBe(
      sourceSessionKey({ sourceId: "ab", sessionId: "c" }),
    );
    for (const malformed of [
      { ...sourceV1, id: "" },
      { ...sourceV1, id: "   " },
      { ...sourceV1, id: "x".repeat(501) },
      { ...sourceV1, unknown: true },
    ]) {
      expect(() => parseSourceInfo(malformed)).toThrow();
    }
  });

  it("requires and owns source IDs without relaxing the canonical parser", () => {
    expect(
      parseSourceSegmentCreate({ ...request, source_id: " source-a " }),
    ).toEqual(request);
    for (const malformed of [
      { ...request, source_id: "" },
      { ...request, source_id: "   " },
      { ...request, source_boundary_version: 3 },
      { ...request, unrelated: true },
    ]) {
      expect(() => parseSourceSegmentCreate(malformed)).toThrow();
    }
    const { source_id: _sourceId, ...withoutSource } = request;
    expect(() => parseSourceSegmentCreate(withoutSource)).toThrow();
    expect(() => parseSegmentCreate(request)).toThrow();
    expect(
      parseSourceSegmentCreate({ ...request, projection_version: true })
        .projection_version,
    ).toBe(1);
    expect(
      parseSourceSegmentCreate({ ...request, projection_version: false })
        .projection_version,
    ).toBe(0);
  });

  it("uses explicit row ownership for persisted legacy segments", () => {
    const { source_id: _sourceId, ...legacy } = request;
    expect(decodePersistedSegment(legacy, "source-a")).toEqual(request);
    expect(() => decodePersistedSegment(legacy, "")).toThrow();
    expect(() =>
      decodePersistedSegment({ ...request, source_id: "source-b" }, "source-a"),
    ).toThrow();
  });

  it("preserves legacy identifiers and fingerprints while isolating source-v1 IDs", () => {
    const owned = parseSourceSegmentCreate(request);
    const legacy = {
      ...owned,
      source_id: legacySource.id,
      source_boundary_version: 1 as const,
      start_source_message_id: null,
      end_source_message_id: null,
    };
    const { source_id: _legacySourceId, ...legacyRequest } = legacy;
    expect(sourceSegmentIdForRequest(legacy, legacySource)).toBe(
      segmentIdForRequest(legacyRequest),
    );
    const anotherOwned: SourceSegmentCreate = {
      ...owned,
      source_id: "another-source",
    };
    expect(sourceFingerprint(owned)).toBe(sourceFingerprint(anotherOwned));
    expect(sourceSegmentIdForRequest(owned, sourceV1)).not.toBe(
      sourceSegmentIdForRequest(
        { ...owned, source_id: "source-b" },
        { ...sourceV1, id: "source-b" },
      ),
    );
    expect(
      sourceSegmentIdForRequest(
        { ...owned, source_id: "😀" },
        { ...sourceV1, id: "😀" },
      ),
    ).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      sourceSegmentIdForRequest(
        { ...owned, source_id: "a", session_id: "bc" },
        { ...sourceV1, id: "a" },
      ),
    ).not.toBe(
      sourceSegmentIdForRequest(
        { ...owned, source_id: "ab", session_id: "c" },
        { ...sourceV1, id: "ab" },
      ),
    );
  });

  it("strictly parses owned response wrappers", () => {
    const job = {
      source_id: "source-a",
      id: 1,
      segment_id: SEGMENT_ID,
      start_user_message_id: "turn",
      end_user_message_id: "turn",
      source_boundary_version: 1 as const,
      start_source_message_id: null,
      end_source_message_id: null,
      source_fingerprint: null,
      projection_version: 1,
      status: "pending" as const,
      attempts: 0,
      error: null,
      created_at: "created",
      started_at: null,
      finished_at: null,
      next_attempt_at: "next",
    };
    const segment = {
      source_id: "source-a",
      id: SEGMENT_ID,
      session_id: "session",
      start_user_message_id: "turn",
      end_user_message_id: "turn",
      source_boundary_version: 1 as const,
      start_source_message_id: null,
      end_source_message_id: null,
      summary: "summary",
      claims: [
        {
          subject: "Subject",
          subject_entity_id: ENTITY_ID,
          predicate: "uses",
          confidence: 1,
          object_entity: null,
          object_entity_id: null,
          object_value: "value",
        },
      ],
      created_at: "created",
      updated_at: "updated",
    };
    const manifest = {
      source_id: "source-a",
      manifest_version: 2 as const,
      session_id: "session",
      segments: [],
      boundaries: [],
      targets: [],
    };

    expect(parseSourceJobResponse(job, "source-a")).toEqual(job);
    expect(parseSourceSegmentResponse(segment, "source-a")).toEqual(segment);
    expect(parseSourceSessionSegmentsResponse(manifest, "source-a")).toEqual(
      manifest,
    );
    for (const parser of [
      () => parseSourceJobResponse({ ...job, extra: true }),
      () =>
        parseSourceSegmentResponse(
          { ...segment, source_id: "source-b" },
          "source-a",
        ),
      () => {
        const { source_id: _sourceId, ...missingSource } = manifest;
        parseSourceSessionSegmentsResponse(missingSource);
      },
    ]) {
      expect(parser).toThrow();
    }
  });
});
