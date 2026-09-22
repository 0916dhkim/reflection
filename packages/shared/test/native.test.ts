import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ContractValidationError } from "../src/contracts.js";
import {
  type NativeSegmentCreate,
  nativeProjectionFingerprint,
  nativeSegmentIdForRequest,
  nativeSourceFingerprint,
  parseNativeJobResponse,
  parseNativeSegmentCreate,
  parseNativeSessionSegmentsResponse,
} from "../src/native.js";
import type { SourceInfo } from "../src/sources.js";

const SEGMENT_ID = "11111111-1111-4111-8111-111111111111";
const registry: SourceInfo = {
  id: "source-a",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
};

const request: NativeSegmentCreate = {
  source_id: "source-a",
  session_id: "session😀",
  source_boundary_version: 3,
  start_source_message_id: "m😀-1",
  end_source_message_id: "m2",
  projection_version: 3,
  processing_priority: 0,
  messages: [
    { id: "m😀-1", type: "user", text: "  hi 😀\n" },
    { id: "m2", type: "synthetic", text: "" },
  ],
};

describe("native v3 segment contracts", () => {
  it("preserves text exactly and has stable Unicode identities", () => {
    expect(
      parseNativeSegmentCreate({
        ...request,
        source_id: " source-a ",
        session_id: " session😀 ",
        start_source_message_id: " m😀-1 ",
        end_source_message_id: " m2 ",
        messages: request.messages.map((message) => ({
          ...message,
          id: ` ${message.id} `,
        })),
      }),
    ).toEqual(request);
    expect(nativeSourceFingerprint(request)).toBe(
      "eaab4957c25565e7a89822598f22b86ea6ae45e2cf82af91b6a57354e1194b4b",
    );
    expect(
      nativeProjectionFingerprint(SEGMENT_ID, "m2", "summary😀\n", 3),
    ).toBe("9466a0bad3b04e413fc513f83494f5f4151441ccf3b8dba7143a11ddffdd34a4");
    expect(nativeSegmentIdForRequest(request, registry)).toBe(
      "43d0e5d4-9564-55bf-a244-d28678586119",
    );
    expect(
      nativeSourceFingerprint({
        ...request,
        messages: [
          { ...request.messages[0]!, type: "synthetic" },
          request.messages[1]!,
        ],
      }),
    ).not.toBe(nativeSourceFingerprint(request));
    expect(
      nativeSourceFingerprint({ ...request, processing_priority: 100 }),
    ).toBe(nativeSourceFingerprint(request));
  });

  it("frames rendering policy separately while excluding processing priority", () => {
    // Explicit UTF-8 byte frames, independent of the production framing helper.
    const prefix = "reflection-source-v3:8:source-a11:session\u{1f600}1:3";
    const suffix =
      "7:m\u{1f600}-12:m22:7:m\u{1f600}-14:user10:  hi \u{1f600}\n2:m29:synthetic0:";
    const digest = (payload: string) =>
      createHash("sha256").update(payload, "utf8").digest("hex");
    const golden =
      "eaab4957c25565e7a89822598f22b86ea6ae45e2cf82af91b6a57354e1194b4b";
    expect(digest(prefix + "1:3" + suffix)).toBe(golden);
    expect(
      nativeSourceFingerprint({ ...request, processing_priority: 100 }),
    ).toBe(golden);
    expect(digest(prefix + suffix)).toBe(
      "7cd171e87030a53b1b684be491e786718c009daf8abc65d0f151cfd00498ff52",
    );
    expect(digest(prefix + "1:4" + suffix)).not.toBe(golden);
    expect(() =>
      parseNativeSegmentCreate({ ...request, projection_version: 4 }),
    ).toThrow();
  });

  it("requires canonical native records and exact endpoints", () => {
    const { source_id: _sourceId, ...withoutSource } = request;
    for (const malformed of [
      withoutSource,
      { ...request, start_user_message_id: "legacy" },
      { ...request, end_user_message_id: null },
      { ...request, projection_version: 2 },
      { ...request, processing_priority: 101 },
      { ...request, messages: [] },
      {
        ...request,
        messages: [
          request.messages[0]!,
          { ...request.messages[1]!, id: request.messages[0]!.id },
        ],
      },
      {
        ...request,
        start_source_message_id: "m2",
        end_source_message_id: "m😀-1",
      },
      {
        ...request,
        messages: [
          { ...request.messages[0]!, source_message_id: "wrong" },
          request.messages[1]!,
        ],
      },
      {
        ...request,
        messages: [{ type: "user", text: "missing id" }, request.messages[1]!],
      },
      {
        ...request,
        messages: [
          { ...request.messages[0]!, type: "unknown" },
          request.messages[1]!,
        ],
      },
    ]) {
      expect(() => parseNativeSegmentCreate(malformed)).toThrow(
        ContractValidationError,
      );
    }
    expect(() =>
      parseNativeSegmentCreate({
        ...request,
        messages: [
          { ...request.messages[0]!, text: "x".repeat(1_000_001) },
          request.messages[1]!,
        ],
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      nativeSegmentIdForRequest(
        { ...request, source_id: "source-b" },
        registry,
      ),
    ).toThrow("does not match");
    expect(() =>
      nativeSegmentIdForRequest(request, {
        ...registry,
        identity_scheme: "legacy",
      }),
    ).toThrow("opencode-v2 source-v1");
    expect(() =>
      parseNativeSegmentCreate({
        ...request,
        end_source_message_id: "m3",
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseNativeSegmentCreate({
        ...request,
        end_source_message_id: "m3",
        messages: [
          { id: "m1", type: "user", text: "x".repeat(1_000_000) },
          { id: "m2", type: "assistant", text: "x".repeat(1_000_000) },
          { id: "m3", type: "synthetic", text: "x" },
        ],
      }),
    ).toThrow(ContractValidationError);
  });

  it("strictly validates owned native responses and manifests", () => {
    const job = {
      source_id: "source-a",
      id: 1,
      segment_id: SEGMENT_ID,
      source_boundary_version: 3,
      start_source_message_id: "m1",
      end_source_message_id: "m2",
      source_fingerprint: null,
      projection_version: 3,
      status: "pending",
      attempts: 0,
      error: null,
      created_at: "created",
      started_at: null,
      finished_at: null,
      next_attempt_at: "next",
    } as const;
    const manifest = {
      source_id: "source-a",
      manifest_version: 3,
      session_id: "session",
      segments: [],
      boundaries: [],
      targets: [],
    } as const;

    expect(parseNativeJobResponse(job, "source-a")).toEqual(job);
    expect(parseNativeSessionSegmentsResponse(manifest, "source-a")).toEqual(
      manifest,
    );
    for (const malformed of [
      { ...job, source_id: "source-b" },
      { ...job, start_user_message_id: "legacy" },
      { ...job, extra: true },
      { ...job, start_source_message_id: null },
    ]) {
      expect(() => parseNativeJobResponse(malformed, "source-a")).toThrow(
        ContractValidationError,
      );
    }
    expect(() =>
      parseNativeSessionSegmentsResponse({ ...manifest, extra: true }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseNativeSessionSegmentsResponse({ ...manifest, manifest_version: 2 }),
    ).toThrow(ContractValidationError);
    const { source_id: _sourceId, ...unowned } = manifest;
    expect(() => parseNativeSessionSegmentsResponse(unowned)).toThrow();
    expect(() =>
      parseNativeSessionSegmentsResponse(manifest, "source-b"),
    ).toThrow();
  });
});
