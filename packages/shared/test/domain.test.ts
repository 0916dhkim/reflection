import { describe, expect, it } from "vitest";

import type {
  ExtractedClaim,
  ResolutionResult,
  SegmentCreate,
} from "../src/contracts.js";
import {
  ExtractionValidationError,
  claimIdFor,
  equivalenceKey,
  newMentionEntityIdFor,
  normalizeName,
  projectionFingerprint,
  projectionFingerprintForBoundary,
  rankAndGroupClaims,
  segmentIdFor,
  segmentIdForRequest,
  sourceFingerprint,
  unionCandidates,
  validateResolutionResult,
  type ClaimSupport,
  type EntityCandidate,
  type MentionContext,
  type RecallCandidate,
} from "../src/domain.js";

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
];

describe("deterministic identities", () => {
  it("matches the persisted Python source fingerprint", () => {
    const request: SegmentCreate = {
      session_id: "session",
      start_user_message_id: "start",
      end_user_message_id: "end",
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
      projection_version: 0,
      processing_priority: 0,
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "world" },
      ],
    };

    expect(sourceFingerprint(request)).toBe(
      "dddcbe20455a0df55fa7c3a01018d29516fa86ea3050fc9a14c4dddfe735ba59",
    );
    expect(
      sourceFingerprint({
        ...request,
        messages: [...request.messages].reverse(),
      }),
    ).not.toBe(sourceFingerprint(request));
    expect(sourceFingerprint({ ...request, processing_priority: 100 })).toBe(
      sourceFingerprint(request),
    );
  });

  it("uses distinct stable V2 sibling identities and mutable endpoints", () => {
    const request: SegmentCreate = {
      session_id: "session",
      start_user_message_id: "turn",
      end_user_message_id: "turn",
      source_boundary_version: 2,
      start_source_message_id: "assistant-1",
      end_source_message_id: "assistant-2",
      projection_version: 1,
      processing_priority: 0,
      messages: [{ role: "assistant", text: "first span" }],
    };
    const advanced: SegmentCreate = {
      ...request,
      end_source_message_id: "assistant-3",
      messages: [...request.messages, { role: "assistant", text: "continued" }],
    };
    const sibling: SegmentCreate = {
      ...request,
      start_source_message_id: "assistant-2",
    };

    expect(segmentIdForRequest(request)).toBe(segmentIdForRequest(advanced));
    expect(segmentIdForRequest(sibling)).not.toBe(segmentIdForRequest(request));
    expect(segmentIdForRequest(request)).not.toBe(
      segmentIdFor("session", "turn"),
    );
    expect(
      sourceFingerprint({
        ...request,
        end_source_message_id: "assistant-3",
      }),
    ).not.toBe(sourceFingerprint(request));
    expect(sourceFingerprint(sibling)).not.toBe(sourceFingerprint(request));
    expect(sourceFingerprint(advanced)).not.toBe(sourceFingerprint(request));
    expect(sourceFingerprint({ ...request, processing_priority: 100 })).toBe(
      sourceFingerprint(request),
    );
  });

  it("uses full case folding and Unicode whitespace", () => {
    expect(normalizeName("  DeepSeek\n V4  ")).toBe("deepseek v4");
    expect(normalizeName("Straße Σς\u001cİ")).toBe("strasse σσ i̇");
  });

  it("keeps stable UUIDv5 namespaces and code-point projection lengths", () => {
    const segmentId = segmentIdFor("session", "start");
    expect(segmentId).toBe("54c7678b-6d18-5202-9e49-24e13baf4204");
    expect(
      segmentIdForRequest({
        session_id: "session",
        start_user_message_id: "start",
        source_boundary_version: 1,
        start_source_message_id: null,
      }),
    ).toBe(segmentId);
    expect(
      newMentionEntityIdFor(segmentId, "fingerprint", "c0.subject", {
        subject: "Example",
        predicate: "is",
        object_entity: null,
        object_value: "true",
      }),
    ).toBe("35fcb996-705f-5f55-8fc2-708db5b2a54c");
    expect(
      newMentionEntityIdFor(segmentId, "fingerprint", "c0.subject", {
        subject: "Example",
        predicate: "is",
        object_entity: null,
        object_value: "true",
      }),
    ).not.toBe(
      newMentionEntityIdFor(segmentId, "fingerprint", "c1.subject", {
        subject: "Example",
        predicate: "is",
        object_entity: null,
        object_value: "true",
      }),
    );
    expect(
      newMentionEntityIdFor(segmentId, "fingerprint", "c0.subject", {
        subject: "Alpha | uses",
        predicate: "supports",
        object_entity: "PostgreSQL",
        object_value: null,
      }),
    ).not.toBe(
      newMentionEntityIdFor(segmentId, "fingerprint", "c0.subject", {
        subject: "Alpha",
        predicate: "uses",
        object_entity: "supports | PostgreSQL",
        object_value: null,
      }),
    );
    expect(claimIdFor(segmentId, 0)).not.toBe(claimIdFor(segmentId, 1));
    expect(projectionFingerprint(segmentId, "end😀", "summary😀", 1)).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      projectionFingerprintForBoundary(
        segmentId,
        {
          sourceBoundaryVersion: 1,
          endUserMessageId: "end😀",
          endSourceMessageId: null,
        },
        "summary😀",
        1,
      ),
    ).toBe(projectionFingerprint(segmentId, "end😀", "summary😀", 1));
  });

  it("includes a V2 mutable end cursor in projection fingerprints", () => {
    const segmentId = segmentIdForRequest({
      session_id: "session",
      start_user_message_id: "turn",
      source_boundary_version: 2,
      start_source_message_id: "assistant-1",
    });
    const first = projectionFingerprintForBoundary(
      segmentId,
      {
        sourceBoundaryVersion: 2,
        endUserMessageId: "turn",
        endSourceMessageId: "assistant-2",
      },
      "summary",
      1,
    );
    const advanced = projectionFingerprintForBoundary(
      segmentId,
      {
        sourceBoundaryVersion: 2,
        endUserMessageId: "turn",
        endSourceMessageId: "assistant-3",
      },
      "summary",
      1,
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(advanced).not.toBe(first);
  });

  it("distinguishes entity and literal equivalence keys", () => {
    const subject = UUIDS[0]!;
    const object = UUIDS[1]!;
    expect(
      equivalenceKey(subject, "uses", {
        objectEntityId: object,
        objectValue: null,
      }),
    ).not.toBe(
      equivalenceKey(subject, "uses", {
        objectEntityId: null,
        objectValue: object,
      }),
    );
  });
});

function entity(id: string, name: string): EntityCandidate {
  return {
    id,
    canonicalName: name,
    description: `Description of ${name}`,
    aliases: [],
  };
}

describe("resolution validation", () => {
  const proposed: ExtractedClaim[] = [
    {
      subject: "Reflection",
      predicate: "uses",
      confidence: 0.7,
      object_entity: "PostgreSQL",
      object_value: null,
    },
  ];

  it("caps each candidate source and preserves first occurrence", () => {
    const candidates = UUIDS.map((id, index) => entity(id, `entity-${index}`));
    expect(
      unionCandidates(candidates, [candidates[0]!, ...candidates.slice(2)]),
    ).toEqual(candidates);
  });

  it("requires supplied candidates and exact occurrence coverage", () => {
    const context: MentionContext = {
      mentionId: "c0.subject",
      role: "subject",
      text: "Reflection",
      supportingClaim: "Reflection | uses | PostgreSQL",
      candidates: [entity(UUIDS[0]!, "Reflection")],
    };
    const bad: ResolutionResult = {
      claims: [{ claim_id: "c0", action: "keep", reason: "supported" }],
      resolutions: [
        {
          mention_id: "c0.subject",
          candidate_entity_id: UUIDS[1]!,
          same_new_entity_as: null,
        },
      ],
    };
    expect(() => validateResolutionResult(proposed, [context], bad)).toThrow(
      ExtractionValidationError,
    );
    const alphabeticId = "deadbeef-dead-4abc-8abc-123456789012";
    expect(() =>
      validateResolutionResult(
        proposed,
        [{ ...context, candidates: [entity(alphabeticId, "Reflection")] }],
        {
          ...bad,
          resolutions: [
            {
              ...bad.resolutions[0]!,
              candidate_entity_id: alphabeticId.toUpperCase(),
            },
          ],
        },
      ),
    ).toThrow("unknown candidate");
    expect(() =>
      validateResolutionResult(
        proposed,
        [context, { ...context, mentionId: "c0.object" }],
        {
          ...bad,
          resolutions: [
            { ...bad.resolutions[0]!, candidate_entity_id: UUIDS[0]! },
          ],
        },
      ),
    ).toThrow("every mention");
  });

  it("allows only direct earlier links between equivalent new mentions", () => {
    const contexts: MentionContext[] = [
      {
        mentionId: "c0.subject",
        role: "subject",
        text: "Reflection",
        supportingClaim: "Reflection | uses | PostgreSQL",
        candidates: [],
      },
      {
        mentionId: "c1.subject",
        role: "subject",
        text: "reflection",
        supportingClaim: "reflection | stores | claims",
        candidates: [],
      },
    ];
    const resolutions = [
      {
        mention_id: "c0.subject",
        candidate_entity_id: null,
        same_new_entity_as: null,
      },
      {
        mention_id: "c1.subject",
        candidate_entity_id: null,
        same_new_entity_as: "c0.subject",
      },
    ];
    const groupedProposed = contexts.map((context, index) => ({
      subject: context.text,
      predicate: "has property",
      confidence: 0.9,
      object_entity: null,
      object_value: String(index),
    }));
    const claims = groupedProposed.map((_, index) => ({
      claim_id: `c${index}`,
      action: "keep" as const,
      reason: "supported" as const,
    }));

    expect(
      validateResolutionResult(groupedProposed, contexts, {
        claims,
        resolutions,
      }).mentions.length,
    ).toBe(2);
    expect(() =>
      validateResolutionResult(groupedProposed, contexts, {
        claims,
        resolutions: [
          { ...resolutions[0]!, same_new_entity_as: "c1.subject" },
          resolutions[1]!,
        ],
      }),
    ).toThrow("invalid new-entity group");
    expect(() =>
      validateResolutionResult(
        groupedProposed,
        [{ ...contexts[0]!, text: "Other" }, contexts[1]!],
        { claims, resolutions },
      ),
    ).toThrow("invalid new-entity group");
  });

  it("keeps original claims and excludes review/drop decisions", () => {
    expect(
      validateResolutionResult(proposed, [], {
        claims: [{ claim_id: "c0", action: "keep", reason: "supported" }],
        resolutions: [],
      }).keptClaims,
    ).toEqual([{ index: 0, claim: proposed[0] }]);
    expect(
      validateResolutionResult(proposed, [], {
        claims: [
          { claim_id: "c0", action: "review", reason: "unstable_scope" },
        ],
        resolutions: [],
      }).keptClaims,
    ).toEqual([]);
  });
});

function recall(
  key: string,
  direct: boolean,
  similarity: number,
  overrides: Partial<RecallCandidate> = {},
): RecallCandidate {
  return {
    subject: "Subject",
    subjectEntityId: UUIDS[0]!,
    predicate: "uses",
    confidence: 0.8,
    objectEntity: "Object",
    objectEntityId: UUIDS[1]!,
    objectValue: null,
    equivalenceKey: key,
    segmentId: UUIDS[2]!,
    similarity,
    seedSimilarity: null,
    isDirect: direct,
    ...overrides,
  };
}

describe("recall ranking", () => {
  it("ranks direct ahead of graph and groups equivalent claims", () => {
    const direct = recall("direct", true, -0.2);
    const equivalent = recall("direct", false, 1, {
      segmentId: UUIDS[3]!,
      seedSimilarity: 1,
    });
    const graph = recall("graph", false, 1, {
      objectEntity: null,
      objectEntityId: null,
      objectValue: "literal",
      seedSimilarity: 0.9,
    });
    const support = new Map<string, ClaimSupport>([
      [
        "direct",
        {
          segmentIds: [direct.segmentId, equivalent.segmentId],
          supportCount: 2,
          sessionCount: 3,
        },
      ],
      [
        "graph",
        { segmentIds: [graph.segmentId], supportCount: 1, sessionCount: 1 },
      ],
    ]);
    const result = rankAndGroupClaims([direct, graph, equivalent], support);
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
    expect(result[0]!.segment_ids).toEqual([
      direct.segmentId,
      equivalent.segmentId,
    ]);
    expect(result[1]!.object_value).toBe("literal");
  });

  it("caps the distinct-session support boost", () => {
    const item = recall("claim", true, 0.5, { confidence: 0.5 });
    const low = rankAndGroupClaims(
      [item],
      new Map([
        [
          "claim",
          { segmentIds: [item.segmentId], supportCount: 1, sessionCount: 1 },
        ],
      ]),
    )[0]!;
    const high = rankAndGroupClaims(
      [item],
      new Map([
        [
          "claim",
          { segmentIds: [item.segmentId], supportCount: 20, sessionCount: 20 },
        ],
      ]),
    )[0]!;
    expect(high.score - low.score).toBeCloseTo(0.1);
  });
});
