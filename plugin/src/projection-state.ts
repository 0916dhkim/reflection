import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { ProjectionSessionState } from "./projection.js";

interface StoredProjectionStateV1 {
  version: 1;
  state: {
    contextLimit: number;
    checkpoint?: {
      tailStartUserMessageId: string;
      summaryText: string;
      createdAtMessageId: string;
      lossy?: boolean;
    };
  };
}

interface StoredProjectionStateV2 {
  version: 2;
  state: ProjectionSessionState;
}

function isSessionState(value: unknown): value is ProjectionSessionState {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.contextLimit !== "number" ||
    !Number.isFinite(item.contextLimit) ||
    item.contextLimit <= 0
  ) {
    return false;
  }
  if (item.checkpoint === undefined) return true;
  if (typeof item.checkpoint !== "object" || item.checkpoint === null)
    return false;
  const checkpoint = item.checkpoint as Record<string, unknown>;
  return (
    !("tailStartUserMessageId" in checkpoint) &&
    typeof checkpoint.tailStartMessageId === "string" &&
    checkpoint.tailStartMessageId.length > 0 &&
    typeof checkpoint.summaryText === "string" &&
    checkpoint.summaryText.length > 0 &&
    typeof checkpoint.createdAtMessageId === "string" &&
    checkpoint.createdAtMessageId.length > 0 &&
    (checkpoint.lossy === undefined || typeof checkpoint.lossy === "boolean")
  );
}

function migrateV1State(value: unknown): ProjectionSessionState | undefined {
  if (typeof value !== "object" || value === null) return;
  const state = value as StoredProjectionStateV1["state"];
  if (
    typeof state.contextLimit !== "number" ||
    !Number.isFinite(state.contextLimit) ||
    state.contextLimit <= 0
  ) {
    return;
  }
  if (state.checkpoint === undefined) {
    return { contextLimit: state.contextLimit };
  }
  const checkpoint = state.checkpoint;
  if (
    typeof checkpoint !== "object" ||
    checkpoint === null ||
    "tailStartMessageId" in checkpoint ||
    typeof checkpoint.tailStartUserMessageId !== "string" ||
    checkpoint.tailStartUserMessageId.length === 0 ||
    typeof checkpoint.summaryText !== "string" ||
    checkpoint.summaryText.length === 0 ||
    typeof checkpoint.createdAtMessageId !== "string" ||
    checkpoint.createdAtMessageId.length === 0 ||
    (checkpoint.lossy !== undefined && typeof checkpoint.lossy !== "boolean")
  ) {
    return;
  }
  return {
    contextLimit: state.contextLimit,
    checkpoint: {
      tailStartMessageId: checkpoint.tailStartUserMessageId,
      summaryText: checkpoint.summaryText,
      createdAtMessageId: checkpoint.createdAtMessageId,
      ...(checkpoint.lossy === undefined ? {} : { lossy: checkpoint.lossy }),
    },
  };
}

export class ProjectionStateStore {
  constructor(private readonly directory: string) {}

  get(sessionId: string): ProjectionSessionState | undefined {
    try {
      const value: unknown = JSON.parse(
        readFileSync(this.path(sessionId), "utf8"),
      );
      if (typeof value !== "object" || value === null) return;
      const stored = value as Partial<
        StoredProjectionStateV1 | StoredProjectionStateV2
      >;
      if (stored.version === 2) {
        return isSessionState(stored.state) ? stored.state : undefined;
      }
      return stored.version === 1 ? migrateV1State(stored.state) : undefined;
    } catch {}
    return undefined;
  }

  set(sessionId: string, state: ProjectionSessionState): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(sessionId);
    const temporary = `${path}.${process.pid}.tmp`;
    const value: StoredProjectionStateV2 = { version: 2, state };
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  delete(sessionId: string): void {
    rmSync(this.path(sessionId), { force: true });
  }

  private path(sessionId: string): string {
    return join(this.directory, `${encodeURIComponent(sessionId)}.json`);
  }
}
