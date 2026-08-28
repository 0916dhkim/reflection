import { randomUUID } from "node:crypto";

import type {
  ExtractedClaim,
  ResolutionResult,
  SegmentCreate,
} from "@reflection/shared/contracts";
import {
  claimIdFor,
  equivalenceKey,
  newMentionEntityIdFor,
  segmentIdForRequest,
  sourceFingerprint,
  validateResolutionResult,
  type EntityCandidate,
  type MentionContext,
  type ValidatedResolutionPlan,
} from "@reflection/shared/domain";
import { describe, expect, test, vi } from "vitest";

import {
  MAX_EMBEDDING_INPUT_BYTES,
  type EmbeddingClient,
  type ModelClient,
} from "../src/clients.js";
import type { ClaimedJob, Database } from "../src/database.js";
import { ExtractionEngine } from "../src/extraction.js";

function request(): SegmentCreate {
  return {
    session_id: "session",
    start_user_message_id: "start",
    end_user_message_id: "end",
    source_boundary_version: 1,
    start_source_message_id: null,
    end_source_message_id: null,
    projection_version: 0,
    processing_priority: 0,
    messages: [{ role: "user", text: "source" }],
  };
}

function jobFor(value: SegmentCreate = request()): ClaimedJob {
  return {
    id: 1,
    segmentId: segmentIdForRequest(value),
    leaseId: randomUUID(),
    sourceGeneration: 1n,
    sourceFingerprint: sourceFingerprint(value),
    attempts: 1,
    request: value,
    extractionResult: null,
  };
}

function asDatabase(
  value: object,
): Pick<Database, "priorSummaries" | "entityCandidates"> {
  return value as Pick<Database, "priorSummaries" | "entityCandidates">;
}

function asModels(value: object): Pick<ModelClient, "extract" | "resolve"> {
  return value as Pick<ModelClient, "extract" | "resolve">;
}

function asEmbeddings(value: object): Pick<EmbeddingClient, "embed"> {
  return value as Pick<EmbeddingClient, "embed">;
}

function resolutionPlan(
  claims: readonly ExtractedClaim[],
  contexts: readonly MentionContext[],
  result: ResolutionResult,
): ValidatedResolutionPlan {
  return validateResolutionResult(claims, contexts, result);
}

class FakeDatabase {
  readonly candidateMentions: string[] = [];

  async priorSummaries(
    _sessionId: string,
    _segmentId: string,
  ): Promise<string[]> {
    return ["prior one", "prior two"];
  }

  async entityCandidates(
    mention: string,
    _embedding: readonly number[],
  ): Promise<readonly EntityCandidate[]> {
    this.candidateMentions.push(mention);
    return [];
  }
}

class FakeModels {
  contexts: readonly MentionContext[] = [];
  priors: readonly string[] = [];
  request: SegmentCreate | null = null;

  async extract(
    requestValue: SegmentCreate,
    priorSummaries: readonly string[],
  ): Promise<{ summary: string; claims: ExtractedClaim[] }> {
    this.request = requestValue;
    this.priors = priorSummaries;
    return {
      summary: "Contextual summary",
      claims: [
        {
          subject: "Alex",
          predicate: "likes",
          confidence: 0.9,
          object_entity: "Jordan",
          object_value: null,
        },
        {
          subject: "Alex",
          predicate: "has age",
          confidence: 0.7,
          object_entity: null,
          object_value: "30 years",
        },
      ],
    };
  }

  async resolve(
    requestValue: SegmentCreate,
    summary: string,
    claims: readonly ExtractedClaim[],
    contexts: readonly MentionContext[],
  ): Promise<ValidatedResolutionPlan> {
    expect(summary).toBe("Contextual summary");
    expect(requestValue).toBe(this.request);
    this.contexts = contexts;
    return validateResolutionResult(claims, contexts, {
      claims: claims.map((_claim, index) => ({
        claim_id: `c${index}`,
        action: "keep",
        reason: "supported",
      })),
      resolutions: contexts.map((context) => ({
        mention_id: context.mentionId,
        candidate_entity_id: null,
        same_new_entity_as: null,
      })),
    });
  }
}

class TriagingModels extends FakeModels {
  override async extract(): Promise<{
    summary: string;
    claims: ExtractedClaim[];
  }> {
    return {
      summary: "PR-specific deployment discussion",
      claims: [
        {
          subject: "log-consumer",
          predicate: "blocks deployment of",
          confidence: 1,
          object_entity: "sampling-coordinator",
          object_value: null,
        },
        {
          subject: "Current discussion",
          predicate: "has temporary note",
          confidence: 0.6,
          object_entity: null,
          object_value: "recheck later",
        },
        {
          subject: "PR #14330 deployment order",
          predicate: "is",
          confidence: 0.95,
          object_entity: null,
          object_value: "log-consumer before sampling-coordinator",
        },
      ],
    };
  }

  override async resolve(
    _requestValue: SegmentCreate,
    summary: string,
    claims: readonly ExtractedClaim[],
    contexts: readonly MentionContext[],
  ): Promise<ValidatedResolutionPlan> {
    expect(summary).toBe("PR-specific deployment discussion");
    expect(claims[0]?.subject).toBe("log-consumer");
    this.contexts = contexts;
    return validateResolutionResult(claims, contexts, {
      claims: [
        { claim_id: "c0", action: "drop", reason: "unsupported" },
        { claim_id: "c1", action: "drop", reason: "transient" },
        { claim_id: "c2", action: "keep", reason: "supported" },
      ],
      resolutions: [
        {
          mention_id: "c2.subject",
          candidate_entity_id: null,
          same_new_entity_as: null,
        },
      ],
    });
  }
}

class FakeEmbeddings {
  readonly calls: Array<{ texts: string[]; inputType: string }> = [];

  async embed(
    texts: readonly string[],
    inputType: string,
  ): Promise<number[][]> {
    this.calls.push({ texts: [...texts], inputType });
    const call = this.calls.length;
    return texts.map((_text, index) => [call * 100 + index]);
  }
}

describe("ExtractionEngine", () => {
  test("resolves occurrences but not literals and includes full claim context", async () => {
    const database = new FakeDatabase();
    const models = new FakeModels();
    const embeddings = new FakeEmbeddings();
    const source = request();
    const job = jobFor(source);
    const engine = new ExtractionEngine(
      asDatabase(database),
      asModels(models),
      asEmbeddings(embeddings),
    );

    const extracted = await engine.extract(job);
    const prepared = await engine.resolve(job, extracted);

    expect(models.request).toBe(source);
    expect(models.priors).toEqual(["prior one", "prior two"]);
    expect(models.contexts.map((context) => context.mentionId)).toEqual([
      "c0.subject",
      "c0.object",
      "c1.subject",
    ]);
    expect(database.candidateMentions).toEqual(["Alex", "Jordan", "Alex"]);
    expect(embeddings.calls[0]?.texts[0]).toContain("Alex | likes | Jordan");
    expect(embeddings.calls[0]?.texts[0]).toContain("Contextual summary");
    expect(prepared.claims[0]?.objectEntityId).not.toBeNull();
    expect(prepared.claims[0]?.confidence).toBe(0.9);
    expect(prepared.claims[0]?.objectValue).toBeNull();
    expect(prepared.claims[1]?.objectEntityId).toBeNull();
    expect(prepared.claims[1]?.objectValue).toBe("30 years");
    expect(prepared.claims[0]?.subjectEntityId).not.toBe(
      prepared.claims[1]?.subjectEntityId,
    );
    expect(
      new Set(prepared.entities.map((entity) => entity.description)),
    ).toEqual(
      new Set([
        "Entity named Alex in claim: Alex | likes | Jordan.",
        "Entity named Jordan in claim: Alex | likes | Jordan.",
        "Entity named Alex in claim: Alex | has age | 30 years.",
      ]),
    );
    expect(prepared.entities.map((entity) => entity.canonicalName)).toEqual([
      "Alex",
      "Jordan",
      "Alex",
    ]);
    expect(prepared.claims.map((claim) => claim.embedding)).toEqual([
      [200],
      [201],
    ]);
    expect(prepared.entities.map((entity) => entity.embedding)).toEqual([
      [202],
      [203],
      [204],
    ]);
    expect(prepared).toMatchObject({
      id: job.segmentId,
      sessionId: "session",
      startUserMessageId: "start",
      endUserMessageId: "end",
      sourceBoundaryVersion: 1,
      startSourceMessageId: null,
      endSourceMessageId: null,
      projectionVersion: 0,
    });
  });

  test("coalesces explicitly grouped mentions of the same new entity", async () => {
    const database = new FakeDatabase();
    const models = asModels({
      extract: vi.fn(async () => ({
        summary: "Shared Concept has two properties.",
        claims: [
          {
            subject: "Shared Concept",
            predicate: "has state",
            confidence: 0.9,
            object_entity: null,
            object_value: "active",
          },
          {
            subject: "shared concept",
            predicate: "has owner",
            confidence: 0.9,
            object_entity: null,
            object_value: "team",
          },
        ] satisfies ExtractedClaim[],
      })),
      resolve: vi.fn(
        async (
          _request: SegmentCreate,
          _summary: string,
          claims: readonly ExtractedClaim[],
          contexts: readonly MentionContext[],
        ): Promise<ValidatedResolutionPlan> =>
          resolutionPlan(claims, contexts, {
            claims: [
              { claim_id: "c0", action: "keep", reason: "supported" },
              { claim_id: "c1", action: "keep", reason: "supported" },
            ],
            resolutions: [
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
            ],
          }),
      ),
    });
    const embeddings = new FakeEmbeddings();
    const claimed = jobFor();
    const engine = new ExtractionEngine(
      asDatabase(database),
      models,
      asEmbeddings(embeddings),
    );

    const prepared = await engine.resolve(
      claimed,
      await engine.extract(claimed),
    );

    expect(prepared.entities).toHaveLength(1);
    expect(prepared.entities[0]?.aliases).toEqual(["Shared Concept"]);
    expect(prepared.claims[0]?.subjectEntityId).toBe(
      prepared.claims[1]?.subjectEntityId,
    );
    expect(embeddings.calls[1]?.texts).toHaveLength(3);
  });

  test("stores only contextualized kept claims with original claim indexes", async () => {
    const database = new FakeDatabase();
    const models = new TriagingModels();
    const embeddings = new FakeEmbeddings();
    const job = jobFor();

    const engine = new ExtractionEngine(
      asDatabase(database),
      asModels(models),
      asEmbeddings(embeddings),
    );
    const prepared = await engine.resolve(job, await engine.extract(job));

    expect(models.contexts.map((context) => context.mentionId)).toEqual([
      "c0.subject",
      "c0.object",
      "c1.subject",
      "c2.subject",
    ]);
    expect(prepared.claims).toHaveLength(1);
    expect(prepared.claims[0]).toMatchObject({
      id: claimIdFor(job.segmentId, 2),
      subject: "PR #14330 deployment order",
      predicate: "is",
      objectValue: "log-consumer before sampling-coordinator",
      objectEntityId: null,
      embedding: [200],
    });
    expect(prepared.claims[0]?.equivalenceKey).toBe(
      equivalenceKey(
        prepared.claims[0]!.subjectEntityId,
        prepared.claims[0]!.predicate,
        {
          objectEntityId: null,
          objectValue: "log-consumer before sampling-coordinator",
        },
      ),
    );
    expect(prepared.entities.map((entity) => entity.canonicalName)).toEqual([
      "PR #14330 deployment order",
    ]);
    expect(embeddings.calls[1]).toEqual({
      inputType: "document",
      texts: [
        "PR #14330 deployment order | is | log-consumer before sampling-coordinator",
        "PR #14330 deployment order: Entity named PR #14330 deployment order in claim: PR #14330 deployment order | is | log-consumer before sampling-coordinator.",
      ],
    });
    expect(embeddings.calls[1]?.texts.join("\n")).not.toContain(
      "Current discussion",
    );
  });

  test("preserves candidate order, exact candidate IDs, and coalesces aliases", async () => {
    const selectedId = randomUUID();
    const otherId = randomUUID();
    const candidates: readonly EntityCandidate[] = [
      {
        id: selectedId,
        canonicalName: "PostgreSQL",
        description: "A relational database",
        aliases: ["Postgres", "PGSQL"],
      },
      {
        id: otherId,
        canonicalName: "Postgres.js",
        description: "A JavaScript library",
        aliases: [],
      },
    ];
    const candidateCalls: string[] = [];
    const database = asDatabase({
      priorSummaries: vi.fn(async () => []),
      entityCandidates: vi.fn(async (mention: string) => {
        candidateCalls.push(mention);
        return candidates;
      }),
    });
    let receivedContexts: readonly MentionContext[] = [];
    const models = asModels({
      extract: vi.fn(async () => ({
        summary: "Database names",
        claims: [
          {
            subject: "Postgres",
            predicate: "has category",
            confidence: 0.9,
            object_entity: null,
            object_value: "database",
          },
          {
            subject: "PostgreSQL",
            predicate: "has license",
            confidence: 0.9,
            object_entity: null,
            object_value: "PostgreSQL License",
          },
        ] satisfies ExtractedClaim[],
      })),
      resolve: vi.fn(
        async (
          _request: SegmentCreate,
          _summary: string,
          claims: readonly ExtractedClaim[],
          contexts: readonly MentionContext[],
        ): Promise<ValidatedResolutionPlan> => {
          receivedContexts = contexts;
          return resolutionPlan(claims, contexts, {
            claims: [
              { claim_id: "c0", action: "keep", reason: "supported" },
              { claim_id: "c1", action: "keep", reason: "supported" },
            ],
            resolutions: [
              {
                mention_id: "c0.subject",
                candidate_entity_id: selectedId,
                same_new_entity_as: null,
              },
              {
                mention_id: "c1.subject",
                candidate_entity_id: selectedId,
                same_new_entity_as: null,
              },
            ],
          });
        },
      ),
    });
    const embeddings = new FakeEmbeddings();

    const engine = new ExtractionEngine(
      database,
      models,
      asEmbeddings(embeddings),
    );
    const claimed = jobFor();
    const prepared = await engine.resolve(
      claimed,
      await engine.extract(claimed),
    );

    expect(candidateCalls).toEqual(["Postgres", "PostgreSQL"]);
    expect(
      receivedContexts[0]?.candidates.map((candidate) => candidate.id),
    ).toEqual([selectedId, otherId]);
    expect(prepared.entities).toEqual([
      {
        id: selectedId,
        canonicalName: "PostgreSQL",
        normalizedName: "postgresql",
        description: "A relational database",
        aliases: ["PostgreSQL", "Postgres", "PGSQL"],
        embedding: null,
        isNew: false,
      },
    ]);
    expect(prepared.claims.map((claim) => claim.subjectEntityId)).toEqual([
      selectedId,
      selectedId,
    ]);
    expect(embeddings.calls[1]?.texts).toEqual([
      "Postgres | has category | database",
      "PostgreSQL | has license | PostgreSQL License",
    ]);
  });

  test("does not persist an alias borrowed from an unselected candidate", async () => {
    const selectedId = randomUUID();
    const database = asDatabase({
      priorSummaries: vi.fn(async () => []),
      entityCandidates: vi.fn(async () => [
        {
          id: selectedId,
          canonicalName: "AlphaService",
          description: "The alpha service",
          aliases: [],
        },
        {
          id: randomUUID(),
          canonicalName: "BetaService",
          description: "The beta service",
          aliases: ["beta service"],
        },
      ]),
    });
    const models = asModels({
      extract: vi.fn(async () => ({
        summary: "Alpha Service exists.",
        claims: [
          {
            subject: "Alpha Service",
            predicate: "exists",
            confidence: 0.9,
            object_entity: null,
            object_value: "true",
          },
        ] satisfies ExtractedClaim[],
      })),
      resolve: vi.fn(
        async (
          _request: SegmentCreate,
          _summary: string,
          claims: readonly ExtractedClaim[],
          contexts: readonly MentionContext[],
        ): Promise<ValidatedResolutionPlan> =>
          resolutionPlan(claims, contexts, {
            claims: [{ claim_id: "c0", action: "keep", reason: "supported" }],
            resolutions: [
              {
                mention_id: "c0.subject",
                candidate_entity_id: selectedId,
                same_new_entity_as: null,
              },
            ],
          }),
      ),
    });
    const engine = new ExtractionEngine(
      database,
      models,
      asEmbeddings(new FakeEmbeddings()),
    );
    const claimed = jobFor({
      ...request(),
      messages: [{ role: "user", text: "Alpha Service exists." }],
    });

    const prepared = await engine.resolve(
      claimed,
      await engine.extract(claimed),
    );

    expect(prepared.entities[0]?.aliases).toEqual([
      "AlphaService",
      "Alpha Service",
    ]);
    expect(prepared.entities[0]?.aliases).not.toContain("beta service");
  });

  test("does not persist punctuated prose from an unselected candidate", async () => {
    const database = asDatabase({
      priorSummaries: vi.fn(async () => []),
      entityCandidates: vi.fn(async () => [
        {
          id: randomUUID(),
          canonicalName: "Unrelated Workspace",
          description: "A separate workspace.",
          aliases: [],
        },
      ]),
    });
    const models = asModels({
      extract: vi.fn(async () => ({
        summary: "Feature and Unrelated Workspace exist.",
        claims: [
          {
            subject: "Feature",
            predicate: "exists",
            confidence: 0.9,
            object_entity: null,
            object_value: "true",
          },
        ] satisfies ExtractedClaim[],
      })),
      resolve: vi.fn(
        async (
          _request: SegmentCreate,
          _summary: string,
          claims: readonly ExtractedClaim[],
          contexts: readonly MentionContext[],
        ): Promise<ValidatedResolutionPlan> =>
          resolutionPlan(claims, contexts, {
            claims: [{ claim_id: "c0", action: "keep", reason: "supported" }],
            resolutions: [
              {
                mention_id: "c0.subject",
                candidate_entity_id: null,
                same_new_entity_as: null,
              },
            ],
          }),
      ),
    });
    const engine = new ExtractionEngine(
      database,
      models,
      asEmbeddings(new FakeEmbeddings()),
    );
    const claimed = jobFor({
      ...request(),
      messages: [
        { role: "user", text: "Feature and Unrelated Workspace exist." },
      ],
    });

    const prepared = await engine.resolve(
      claimed,
      await engine.extract(claimed),
    );

    expect(prepared.entities[0]).toMatchObject({
      canonicalName: "Feature",
      description: "Entity named Feature in claim: Feature | exists | true.",
      aliases: ["Feature"],
      isNew: true,
    });
    expect(prepared.entities[0]?.description).not.toContain(
      "separate workspace",
    );
  });

  test("derives new entity metadata from the extracted mention", async () => {
    const candidate = {
      id: randomUUID(),
      canonicalName: "Existing",
      description: "Existing entity",
      aliases: [],
    } satisfies EntityCandidate;
    const database = asDatabase({
      priorSummaries: vi.fn(async () => []),
      entityCandidates: vi.fn(async () => [candidate]),
    });
    const models = asModels({
      extract: vi.fn(async () => ({
        summary: "summary",
        claims: [
          {
            subject: "New Concept",
            predicate: "has state",
            confidence: 0.8,
            object_entity: null,
            object_value: "planned",
          },
        ] satisfies ExtractedClaim[],
      })),
      resolve: vi.fn(
        async (
          _request: SegmentCreate,
          _summary: string,
          claims: readonly ExtractedClaim[],
          contexts: readonly MentionContext[],
        ): Promise<ValidatedResolutionPlan> =>
          resolutionPlan(claims, contexts, {
            claims: [{ claim_id: "c0", action: "keep", reason: "supported" }],
            resolutions: [
              {
                mention_id: "c0.subject",
                candidate_entity_id: null,
                same_new_entity_as: null,
              },
            ],
          }),
      ),
    });

    const engine = new ExtractionEngine(
      database,
      models,
      asEmbeddings(new FakeEmbeddings()),
    );
    const claimed = jobFor();
    const prepared = await engine.resolve(
      claimed,
      await engine.extract(claimed),
    );

    expect(prepared.entities[0]).toMatchObject({
      id: newMentionEntityIdFor(
        jobFor().segmentId,
        jobFor().sourceFingerprint,
        "c0.subject",
        {
          subject: "New Concept",
          predicate: "has state",
          object_entity: null,
          object_value: "planned",
        },
      ),
      canonicalName: "New Concept",
      description:
        "Entity named New Concept in claim: New Concept | has state | planned.",
      aliases: ["New Concept"],
      isNew: true,
    });
  });

  test("bounds generated descriptions and embedding documents", async () => {
    const literal = "界".repeat(10_000);
    const database = new FakeDatabase();
    const models = asModels({
      extract: vi.fn(async () => ({
        summary: "A long literal is retained.",
        claims: [
          {
            subject: "New Concept",
            predicate: "has payload",
            confidence: 0.8,
            object_entity: null,
            object_value: literal,
          },
        ] satisfies ExtractedClaim[],
      })),
      resolve: vi.fn(
        async (
          _request: SegmentCreate,
          _summary: string,
          claims: readonly ExtractedClaim[],
          contexts: readonly MentionContext[],
        ): Promise<ValidatedResolutionPlan> =>
          resolutionPlan(claims, contexts, {
            claims: [{ claim_id: "c0", action: "keep", reason: "supported" }],
            resolutions: [
              {
                mention_id: "c0.subject",
                candidate_entity_id: null,
                same_new_entity_as: null,
              },
            ],
          }),
      ),
    });
    const embeddings = new FakeEmbeddings();
    const claimed = jobFor();
    const engine = new ExtractionEngine(
      asDatabase(database),
      models,
      asEmbeddings(embeddings),
    );

    const prepared = await engine.resolve(
      claimed,
      await engine.extract(claimed),
    );

    expect([...prepared.entities[0]!.description]).toHaveLength(2_000);
    expect(
      embeddings.calls
        .flatMap((call) => call.texts)
        .every(
          (text) =>
            Buffer.byteLength(text, "utf8") <= MAX_EMBEDDING_INPUT_BYTES,
        ),
    ).toBe(true);
  });

  test("skips joint resolution when extraction returns no claims", async () => {
    const resolve = vi.fn();
    const models = asModels({
      extract: vi.fn(async () => ({ summary: "summary", claims: [] })),
      resolve,
    });
    const embeddings = new FakeEmbeddings();
    const engine = new ExtractionEngine(
      asDatabase(new FakeDatabase()),
      models,
      asEmbeddings(embeddings),
    );
    const claimed = jobFor();
    const prepared = await engine.resolve(
      claimed,
      await engine.extract(claimed),
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(prepared.claims).toEqual([]);
    expect(prepared.entities).toEqual([]);
    expect(embeddings.calls).toEqual([
      { texts: [], inputType: "query" },
      { texts: [], inputType: "document" },
    ]);
  });
});
