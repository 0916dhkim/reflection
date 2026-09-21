import { describe, expect, it } from "vitest";

import { sourceFingerprint } from "../src/domain.js";
import {
  decodePersistedIngestSegment,
  ingestProjectionFingerprintForBoundary,
  ingestSegmentIdForRequest,
  ingestSourceFingerprint,
  ownedIngestRequest,
  parseIngestSegmentCreate,
  parseIngestSessionSegmentsResponse,
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

  it("accepts per-entry native manifest boundaries with strict outer ownership", () => {
    const manifest = {
      source_id: "source-a",
      manifest_version: 2 as const,
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
  });
});
