import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { ProjectionSessionState } from "./projection.js";

interface StoredProjectionState {
  version: 1;
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
    typeof checkpoint.tailStartUserMessageId === "string" &&
    checkpoint.tailStartUserMessageId.length > 0 &&
    typeof checkpoint.summaryText === "string" &&
    checkpoint.summaryText.length > 0 &&
    typeof checkpoint.createdAtMessageId === "string" &&
    checkpoint.createdAtMessageId.length > 0 &&
    (checkpoint.lossy === undefined || typeof checkpoint.lossy === "boolean")
  );
}

export class ProjectionStateStore {
  constructor(private readonly directory: string) {}

  get(sessionId: string): ProjectionSessionState | undefined {
    try {
      const value: unknown = JSON.parse(
        readFileSync(this.path(sessionId), "utf8"),
      );
      if (typeof value !== "object" || value === null) return;
      const state = value as Partial<StoredProjectionState>;
      return state.version === 1 && isSessionState(state.state)
        ? state.state
        : undefined;
    } catch {}
    return undefined;
  }

  set(sessionId: string, state: ProjectionSessionState): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(sessionId);
    const temporary = `${path}.${process.pid}.tmp`;
    const value: StoredProjectionState = { version: 1, state };
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
