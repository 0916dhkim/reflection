import { randomUUID } from "node:crypto";

import type { ClaimSupport, RecallCandidate } from "@reflection/shared/domain";
import { describe, expect, test, vi } from "vitest";

import type { EmbeddingClient } from "../src/clients.js";
import type { Database } from "../src/database.js";
import { SearchService } from "../src/search.js";

const QUERY_EMBEDDING = Array.from({ length: 1024 }, () => 0.01);

function recallCandidate(options: {
  direct: boolean;
  key: string;
  similarity: number;
  subjectEntityId?: string;
  objectEntityId?: string | null;
}): RecallCandidate {
  const objectEntityId =
    options.objectEntityId === undefined
      ? randomUUID()
      : options.objectEntityId;
  return {
    subject: "Reflection",
    subjectEntityId: options.subjectEntityId ?? randomUUID(),
    predicate: "uses",
    confidence: 0.8,
    objectEntity: objectEntityId === null ? null : "PostgreSQL",
    objectEntityId,
    objectValue: objectEntityId === null ? "a literal" : null,
    equivalenceKey: options.key,
    segmentId: randomUUID(),
    similarity: options.similarity,
    seedSimilarity: options.direct ? null : 0.7,
    isDirect: options.direct,
  };
}

function asDatabase(
  value: object,
): Pick<
  Database,
  "directClaims" | "neighboringClaims" | "supportForEquivalenceKeys"
> {
  return value as Pick<
    Database,
    "directClaims" | "neighboringClaims" | "supportForEquivalenceKeys"
  >;
}

function asEmbeddings(value: object): Pick<EmbeddingClient, "embed"> {
  return value as Pick<EmbeddingClient, "embed">;
}

describe("SearchService", () => {
  test("passes the query embedding and strongest direct score to each unique entity expansion", async () => {
    const sharedEntity = randomUUID();
    const direct = recallCandidate({
      direct: true,
      key: "direct",
      similarity: 0.9,
      subjectEntityId: sharedEntity,
    });
    const weaker = recallCandidate({
      direct: true,
      key: "weaker",
      similarity: 0.6,
      subjectEntityId: sharedEntity,
      objectEntityId: null,
    });
    const graph = recallCandidate({
      direct: false,
      key: "graph",
      similarity: 0.6,
    });
    const neighboringClaims = vi.fn(async () => [graph]);
    const support = new Map<string, ClaimSupport>([
      [
        "direct",
        { segmentIds: [direct.segmentId], supportCount: 3, sessionCount: 2 },
      ],
      [
        "weaker",
        { segmentIds: [weaker.segmentId], supportCount: 1, sessionCount: 1 },
      ],
      [
        "graph",
        { segmentIds: [graph.segmentId], supportCount: 1, sessionCount: 1 },
      ],
    ]);
    const database = asDatabase({
      directClaims: vi.fn(async () => [direct, weaker]),
      neighboringClaims,
      supportForEquivalenceKeys: vi.fn(async () => support),
    });
    const embeddings = asEmbeddings({
      embed: vi.fn(async () => [QUERY_EMBEDDING]),
    });

    const result = await new SearchService(database, embeddings).search(
      "query",
    );

    expect(embeddings.embed).toHaveBeenCalledWith(["query"], "query");
    expect(database.directClaims).toHaveBeenCalledWith(QUERY_EMBEDDING, 10);
    expect(neighboringClaims).toHaveBeenCalledTimes(2);
    expect(neighboringClaims).toHaveBeenCalledWith(
      sharedEntity,
      QUERY_EMBEDDING,
      0.9,
      10,
    );
    expect(result.claims[0]?.score).toBeGreaterThan(
      result.claims.at(-1)?.score ?? 0,
    );
    expect(
      result.claims.find((claim) => claim.predicate === "uses"),
    ).toMatchObject({
      support_count: 3,
      session_count: 2,
    });
  });

  test("does not expand or query support unnecessarily when direct recall is empty", async () => {
    const database = asDatabase({
      directClaims: vi.fn(async () => []),
      neighboringClaims: vi.fn(async () => []),
      supportForEquivalenceKeys: vi.fn(async () => new Map()),
    });
    const embeddings = asEmbeddings({
      embed: vi.fn(async () => [QUERY_EMBEDDING]),
    });

    await expect(
      new SearchService(database, embeddings).search("query"),
    ).resolves.toEqual({
      claims: [],
    });
    expect(database.neighboringClaims).not.toHaveBeenCalled();
    expect(database.supportForEquivalenceKeys).toHaveBeenCalledWith([]);
  });

  test("fails closed if the embedding client violates its one-result contract", async () => {
    const embeddings = asEmbeddings({ embed: vi.fn(async () => []) });
    const database = asDatabase({
      directClaims: vi.fn(),
      neighboringClaims: vi.fn(),
      supportForEquivalenceKeys: vi.fn(),
    });

    await expect(
      new SearchService(database, embeddings).search("query"),
    ).rejects.toThrow("embedding client returned no query embedding");
    expect(database.directClaims).not.toHaveBeenCalled();
  });
});
