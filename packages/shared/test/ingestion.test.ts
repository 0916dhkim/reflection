import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import { sourceFingerprint } from "../src/domain.js";
import {
  decodePersistedIngestSegment,
  ingestProjectionFingerprintForBoundary,
  ingestSegmentIdForRequest,
  ingestSourceFingerprint,
  ownedIngestRequest,
  parseIngestSegmentCreate,
  parseIngestSessionSegmentsResponse,
  IngestSessionSegmentsResponseSchema,
} from "../src/ingestion.js";
import {
  nativeProjectionFingerprint,
  nativeSourceFingerprint,
} from "../src/native.js";
import type { SourceInfo } from "../src/sources.js";

const native = {
  source_id: "source-a",
  session_id: "session",
  source_boundary_version: 3 as const,
  start_source_message_id: "m1",
  end_source_message_id: "m2",
  projection_version: 3 as const,
  processing_priority: 10,
  messages: [
    { id: "m1", type: "user" as const, text: "request" },
    { id: "m2", type: "assistant" as const, text: "answer" },
  ],
};
const legacy = {
  source_id: "source-a",
  session_id: "session",
  start_user_message_id: "u1",
  end_user_message_id: "u1",
  source_boundary_version: 2 as const,
  start_source_message_id: "u1",
  end_source_message_id: "a1",
  projection_version: 0 as const,
  processing_priority: 0,
  messages: [{ role: "user" as const, text: "request" }],
};
const source: SourceInfo = {
  id: "source-a",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
};

describe("ingestion compatibility dispatch", () => {
  it("keeps legacy requests and hashes unchanged while dispatching native", () => {
    const parsedLegacy = parseIngestSegmentCreate(legacy);
    const parsedNative = parseIngestSegmentCreate(native);
    if (parsedLegacy.source_boundary_version === 3) {
      throw new Error("expected a legacy segment");
    }
    if (parsedNative.source_boundary_version !== 3) {
      throw new Error("expected a native segment");
    }
    expect(parsedLegacy).toEqual(legacy);
    expect(parsedNative).toEqual(native);
    expect(ingestSourceFingerprint(parsedLegacy)).toBe(
      sourceFingerprint(parsedLegacy),
    );
    expect(ingestSourceFingerprint(parsedNative)).toBe(
      nativeSourceFingerprint(parsedNative),
    );
    expect(ingestSegmentIdForRequest(parsedNative, source)).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(
      ingestProjectionFingerprintForBoundary(
        "11111111-1111-4111-8111-111111111111",
        parsedNative,
        "summary",
        3,
      ),
    ).toBe(
      nativeProjectionFingerprint(
        "11111111-1111-4111-8111-111111111111",
        "m2",
        "summary",
        3,
      ),
    );
  });

  it("does not infer native ownership while preserving legacy persistence", () => {
    const { source_id: _sourceId, ...legacyPersisted } = legacy;
    expect(ownedIngestRequest(legacyPersisted, "source-a")).toEqual(legacy);
    expect(decodePersistedIngestSegment(legacyPersisted, "source-a")).toEqual(
      legacy,
    );
    const { source_id: _nativeSourceId, ...nativeWithoutSource } = native;
    expect(() =>
      decodePersistedIngestSegment(nativeWithoutSource, "source-a"),
    ).toThrow();
    expect(() => decodePersistedIngestSegment(native, "source-b")).toThrow();
    expect(() => ownedIngestRequest(native, "source-b")).toThrow();
  });

  it("separates native manifest 3 from legacy manifest 2 with strict ownership", () => {
    const manifest = {
      source_id: "source-a",
      manifest_version: 3 as const,
      session_id: "session",
      segments: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          source_boundary_version: 3 as const,
          start_source_message_id: "m1",
          end_source_message_id: "m2",
          projection_version: 3,
          summary: "summary",
        },
      ],
      boundaries: [],
      targets: [],
    };
    expect(parseIngestSessionSegmentsResponse(manifest, "source-a")).toEqual(
      manifest,
    );
    expect(() =>
      parseIngestSessionSegmentsResponse(
        { ...manifest, source_id: "source-b" },
        "source-a",
      ),
    ).toThrow();
    const legacyEntry = {
      id: manifest.segments[0]!.id,
      source_boundary_version: 2,
      start_user_message_id: "u1",
      end_user_message_id: "u1",
      start_source_message_id: "u1",
      end_source_message_id: "a1",
      projection_version: 1,
      summary: "legacy",
    };
    const legacyManifest = {
      ...manifest,
      manifest_version: 2,
      segments: [
        legacyEntry,
        {
          ...legacyEntry,
          source_boundary_version: 1,
          start_source_message_id: null,
          end_source_message_id: null,
        },
      ],
    };
    for (const valid of [manifest, legacyManifest]) {
      expect(Value.Check(IngestSessionSegmentsResponseSchema, valid)).toBe(
        true,
      );
      expect(parseIngestSessionSegmentsResponse(valid, " source-a ")).toEqual(
        valid,
      );
      expect(
        parseIngestSessionSegmentsResponse({ ...valid, segments: [] }),
      ).toEqual({ ...valid, segments: [] });
      const { source_id: _sourceId, ...unowned } = valid;
      expect(() => parseIngestSessionSegmentsResponse(unowned)).toThrow();
    }
    for (const invalid of [
      { ...manifest, manifest_version: 2 },
      { ...manifest, manifest_version: 4 },
      { ...legacyManifest, manifest_version: 3 },
      { ...manifest, segments: [...manifest.segments, legacyEntry] },
      {
        ...legacyManifest,
        segments: [...legacyManifest.segments, ...manifest.segments],
      },
    ]) {
      expect(Value.Check(IngestSessionSegmentsResponseSchema, invalid)).toBe(
        false,
      );
      expect(() => parseIngestSessionSegmentsResponse(invalid)).toThrow();
    }
    const { summary: _legacySummary, ...legacyRange } = legacyEntry;
    const { summary: _nativeSummary, ...nativeRange } = manifest.segments[0]!;
    for (const [key, metadata] of [
      ["boundaries", { source_eligible: true, source_fingerprint: "hash" }],
      ["targets", { status: "pending", source_fingerprint: "hash" }],
    ] as const) {
      for (const [base, range, otherRange] of [
        [manifest, nativeRange, legacyRange],
        [legacyManifest, legacyRange, nativeRange],
      ] as const) {
        const valid = { ...base, [key]: [{ ...range, ...metadata }] };
        expect(Value.Check(IngestSessionSegmentsResponseSchema, valid)).toBe(
          true,
        );
        expect(parseIngestSessionSegmentsResponse(valid)).toEqual(valid);
        for (const entries of [
          [{ ...otherRange, ...metadata }],
          [
            { ...range, ...metadata },
            { ...otherRange, ...metadata },
          ],
        ]) {
          const invalid = { ...base, [key]: entries };
          expect(
            Value.Check(IngestSessionSegmentsResponseSchema, invalid),
          ).toBe(false);
          expect(() => parseIngestSessionSegmentsResponse(invalid)).toThrow();
        }
      }
    }
  });
});
