import {
  rankAndGroupClaims,
  type RecallCandidate,
} from "@reflection/shared/domain";
import type { SearchResponse } from "@reflection/shared/contracts";

import type { EmbeddingClient } from "./clients.js";
import type { Database } from "./database.js";

type SearchDatabase = Pick<
  Database,
  "directClaims" | "neighboringClaims" | "supportForEquivalenceKeys"
>;
type SearchEmbeddings = Pick<EmbeddingClient, "embed">;

export class SearchService {
  readonly #database: SearchDatabase;
  readonly #embeddings: SearchEmbeddings;

  constructor(database: SearchDatabase, embeddings: SearchEmbeddings) {
    this.#database = database;
    this.#embeddings = embeddings;
  }

  async search(query: string): Promise<SearchResponse> {
    const embedding = (await this.#embeddings.embed([query], "query"))[0];
    if (embedding === undefined) {
      throw new Error("embedding client returned no query embedding");
    }

    const direct = await this.#database.directClaims(embedding, 10);
    const entityScores = new Map<string, number>();
    for (const claim of direct) {
      const entityIds = [claim.subjectEntityId];
      if (claim.objectEntityId !== null) entityIds.push(claim.objectEntityId);
      for (const entityId of entityIds) {
        entityScores.set(
          entityId,
          Math.max(entityScores.get(entityId) ?? 0, claim.similarity),
        );
      }
    }

    const neighborGroups = await Promise.all(
      [...entityScores].map(([entityId, score]) =>
        this.#database.neighboringClaims(entityId, embedding, score, 10),
      ),
    );
    const allCandidates: RecallCandidate[] = [
      ...direct,
      ...neighborGroups.flat(),
    ];
    const keys = [...new Set(allCandidates.map((item) => item.equivalenceKey))];
    const support = await this.#database.supportForEquivalenceKeys(keys);
    return { claims: rankAndGroupClaims(allCandidates, support, 20) };
  }
}
