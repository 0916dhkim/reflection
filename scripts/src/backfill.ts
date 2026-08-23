import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  parseJobResponse,
  parseSegmentCreate,
  parseSessionSegmentsResponse,
  type JobResponse,
  type JobStatus,
  type SegmentBoundary,
  type SegmentCreate,
  type SegmentTargetBoundary,
  type SessionSegmentsResponse,
} from "@reflection/shared/contracts";
import {
  segmentIdForRequest,
  sourceFingerprint,
} from "@reflection/shared/domain";
import {
  isSafeSegmentSnapshot,
  segmentMessages,
  type CommittedSegmentBoundary,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "@reflection/shared/segmentation";

export const MAX_SEGMENT_CHARS = 20_000;
export const PROJECTION_VERSION = 1;
export const INACTIVE_MS = 10 * 60 * 1_000;
export const DEFAULT_PROVIDER_POLL_MS = 5 * 60_000;
export const DEFAULT_JOB_POLL_MS = 2_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_MUTABLE_SOURCE_DEFERRAL_MS = 24 * 60 * 60_000;
const MAX_PROJECTION_UPGRADE_REPLAYS = 2;
export const MAX_NON_PROVIDER_JOB_ROUNDS = 2;

export const SESSION_QUERY =
  "SELECT id, title, time_updated AS timeUpdated FROM session ORDER BY time_created DESC, id DESC";
export const SESSION_STATUS_QUERY =
  "SELECT time_updated AS timeUpdated FROM session WHERE id = ?";
export const MESSAGE_QUERY = `
  SELECT m.id, m.data
  FROM message m
  WHERE m.session_id = ?
  ORDER BY m.time_created, m.id
`;
export const PART_QUERY = `
  SELECT id, message_id AS messageId, data
  FROM part
  WHERE session_id = ?
  ORDER BY message_id, id
`;

export type SegmentPlanStatus =
  | "eligible_committed"
  | "stale_committed"
  | "target_pending"
  | "target_running"
  | "target_succeeded"
  | "target_failed"
  | "target_superseded"
  | "conflicting"
  | "new";
export type DryRunStatus = SegmentPlanStatus | "invalid";
export type SegmentPlanDisposition = "ready" | "deferred_mutable_source";
export type SegmentPlanDrift =
  | "missing_manifest_fingerprint"
  | "source_fingerprint_mismatch"
  | "projection_version_mismatch"
  | "conflicting_manifest_entries";
export type BackfillStatus =
  | "starting"
  | "running"
  | "waiting_for_provider"
  | "waiting_for_session_inactivity"
  | "completed"
  | "completed_with_failures"
  | "failed";

export interface SessionRow {
  id: string;
  title: string | null;
  timeUpdated: number;
}

export interface MessageRow {
  id: string;
  data: string;
}

export interface PartRow {
  id: string;
  messageId: string;
  data: string;
}

export type ReflectionJob = JobResponse;
export type SegmentManifest = SessionSegmentsResponse;

export type PlannedSegment = ReflectionSegment & {
  segmentId: string;
  sourceFingerprint: string;
  submission: SegmentCreate;
  serializedSubmission: string;
  status: SegmentPlanStatus;
  drifts: SegmentPlanDrift[];
  manifestSourceFingerprint: string | null;
  targetStatus: JobStatus | null;
  disposition: SegmentPlanDisposition;
};

export interface BackfillFailure {
  sessionId: string | null;
  segmentId: string | null;
  startUserMessageId: string | null;
  endUserMessageId: string | null;
  sourceBoundaryVersion: 1 | 2 | null;
  startSourceMessageId: string | null;
  endSourceMessageId: string | null;
  sourceFingerprint: string | null;
  jobId: number | null;
  error: string;
}

export interface CurrentSegment {
  index: number;
  count: number;
  segmentId: string;
  startUserMessageId: string;
  endUserMessageId: string;
  sourceBoundaryVersion: 1 | 2;
  startSourceMessageId: string | null;
  endSourceMessageId: string | null;
  sourceFingerprint: string;
  status: SegmentPlanStatus;
}

export interface ProviderStatus extends Record<string, unknown> {
  jobId: number;
  segmentId: string;
  sourceBoundaryVersion: 1 | 2;
  startSourceMessageId: string | null;
  endSourceMessageId: string | null;
  sourceFingerprint: string | null;
  error: string | null;
  nextRetryAt: string;
}

export interface CleanupStatus {
  status: "scheduled";
  label: string;
  plist: string;
  scheduledAt: string;
}

export interface BackfillState {
  runCount: number;
  startedAt: string;
  updatedAt: string;
  status: BackfillStatus;
  sessionsTotal: number;
  sessionsVisited: number;
  segmentsDiscovered: number;
  segmentsSucceeded: number;
  segmentsAlreadySucceeded: number;
  segmentsFailed: number;
  currentSessionId: string | null;
  currentSessionTitle: string | null;
  currentSegment: CurrentSegment | null;
  providerStatus: Record<string, unknown>;
  failures: BackfillFailure[];
  cleanup?: CleanupStatus;
  deferredSessions?: number;
  completedAt?: string;
  fatalError?: string;
}

export interface BackfillOptions {
  dryRun: boolean;
  allowFailures: boolean;
  stateDirectory: string;
  statePath: string;
  lockPath: string;
  sqlitePath: string;
  reflectionConfigPath: string;
  launchdLabel: string | undefined;
  launchdPlist: string | undefined;
  providerPollMs: number;
  jobPollMs: number;
  requestTimeoutMs: number;
  maxMutableSourceDeferralMs: number;
  priorityJobIds: number[];
}

export interface Clock {
  nowIso(): string;
  nowMs(): number;
}

export type Sleep = (milliseconds: number) => Promise<void>;
export type Log = (message: string, details?: Record<string, unknown>) => void;
export type Revalidate = () => void | Promise<void>;

const SYSTEM_CLOCK: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

export function resolveBackfillOptions(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  home = homedir(),
): BackfillOptions {
  const stateDirectory =
    environment.REFLECTION_BACKFILL_STATE_DIR ??
    join(home, ".local/state/reflection-backfill");
  const rawLaunchdLabel = environment.REFLECTION_BACKFILL_LAUNCHD_LABEL;
  const launchdLabel = rawLaunchdLabel?.trim();
  const launchdPlist = environment.REFLECTION_BACKFILL_LAUNCHD_PLIST;
  if (rawLaunchdLabel !== undefined && !launchdLabel) {
    throw new Error("REFLECTION_BACKFILL_LAUNCHD_LABEL must be nonempty");
  }
  if ((launchdLabel === undefined) !== (launchdPlist === undefined)) {
    throw new Error(
      "REFLECTION_BACKFILL_LAUNCHD_LABEL and REFLECTION_BACKFILL_LAUNCHD_PLIST must be configured together",
    );
  }
  if (launchdPlist !== undefined && !isAbsolute(launchdPlist)) {
    throw new Error("REFLECTION_BACKFILL_LAUNCHD_PLIST must be absolute");
  }
  if (launchdLabel !== undefined && !isAbsolute(stateDirectory)) {
    throw new Error(
      "REFLECTION_BACKFILL_STATE_DIR must be absolute when LaunchAgent cleanup is configured",
    );
  }
  return {
    dryRun: argv.includes("--dry-run"),
    allowFailures: argv.includes("--allow-failures"),
    stateDirectory,
    statePath: join(stateDirectory, "state.json"),
    lockPath: join(stateDirectory, "worker.lock"),
    sqlitePath:
      environment.OPENCODE_DATABASE_PATH ??
      join(home, ".local/share/opencode/opencode.db"),
    reflectionConfigPath: join(home, ".config/opencode/reflection.json"),
    launchdLabel,
    launchdPlist,
    providerPollMs: positiveIntegerEnvironment(
      "REFLECTION_PROVIDER_POLL_MS",
      environment.REFLECTION_PROVIDER_POLL_MS,
      DEFAULT_PROVIDER_POLL_MS,
    ),
    jobPollMs: positiveIntegerEnvironment(
      "REFLECTION_JOB_POLL_MS",
      environment.REFLECTION_JOB_POLL_MS,
      DEFAULT_JOB_POLL_MS,
    ),
    requestTimeoutMs: positiveIntegerEnvironment(
      "REFLECTION_REQUEST_TIMEOUT_MS",
      environment.REFLECTION_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    maxMutableSourceDeferralMs: positiveIntegerEnvironment(
      "REFLECTION_MAX_MUTABLE_SOURCE_DEFERRAL_MS",
      environment.REFLECTION_MAX_MUTABLE_SOURCE_DEFERRAL_MS,
      DEFAULT_MAX_MUTABLE_SOURCE_DEFERRAL_MS,
    ),
    priorityJobIds: parsePriorityJobIds(
      environment.REFLECTION_BACKFILL_PRIORITY_JOB_IDS,
    ),
  };
}

export function positiveIntegerEnvironment(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite integer`);
  }
  return parsed;
}

export function parsePriorityJobIds(value: string | undefined): number[] {
  if (value === undefined || value.trim() === "") return [];
  const result = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) =>
      positiveIntegerEnvironment(
        "REFLECTION_BACKFILL_PRIORITY_JOB_IDS",
        item,
        1,
      ),
    );
  return [...new Set(result)];
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

export function logLine(
  timestamp: string,
  message: string,
  details: Record<string, unknown> = {},
): string {
  return JSON.stringify({ timestamp, message, ...details });
}

export function createInitialState(
  previousState: unknown,
  nowIso: () => string,
): BackfillState {
  const previous = previousState as { runCount?: unknown };
  return {
    runCount: Number(previous.runCount ?? 0) + 1,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    status: "starting",
    sessionsTotal: 0,
    sessionsVisited: 0,
    segmentsDiscovered: 0,
    segmentsSucceeded: 0,
    segmentsAlreadySucceeded: 0,
    segmentsFailed: 0,
    currentSessionId: null,
    currentSessionTitle: null,
    currentSegment: null,
    providerStatus: {},
    failures: [],
  };
}

export function serializeState(state: BackfillState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function recordFailureInState(
  state: BackfillState,
  sessionId: string | null,
  segment: Pick<
    PlannedSegment,
    | "segmentId"
    | "startUserMessageId"
    | "endUserMessageId"
    | "sourceBoundaryVersion"
    | "startSourceMessageId"
    | "endSourceMessageId"
    | "sourceFingerprint"
  > | null,
  job: Pick<ReflectionJob, "id" | "error"> | null,
  error?: unknown,
): void {
  state.segmentsFailed += 1;
  state.failures.push({
    sessionId,
    segmentId: segment?.segmentId ?? null,
    startUserMessageId: segment?.startUserMessageId ?? null,
    endUserMessageId: segment?.endUserMessageId ?? null,
    sourceBoundaryVersion: segment?.sourceBoundaryVersion ?? null,
    startSourceMessageId: segment?.startSourceMessageId ?? null,
    endSourceMessageId: segment?.endSourceMessageId ?? null,
    sourceFingerprint: segment?.sourceFingerprint ?? null,
    jobId: job?.id ?? null,
    error: String(error ?? job?.error ?? "unknown failure").slice(0, 1_000),
  });
  state.failures = state.failures.slice(-100);
}

export function hydrateSessionMessages(
  sessionId: string,
  messageRows: readonly MessageRow[],
  partRows: readonly PartRow[],
): OpenCodeMessage[] {
  const partsByMessage = new Map<string, PartRow[]>();
  for (const part of partRows) {
    const parts = partsByMessage.get(part.messageId);
    if (parts) parts.push(part);
    else partsByMessage.set(part.messageId, [part]);
  }

  return messageRows.map((row) => {
    const info = JSON.parse(row.data) as unknown;
    return {
      info: {
        ...(info as Record<string, unknown>),
        id: row.id,
        sessionID: sessionId,
      },
      parts: (partsByMessage.get(row.id) ?? []).map((part) => {
        const data = JSON.parse(part.data) as unknown;
        return {
          ...(data as Record<string, unknown>),
          id: part.id,
          messageID: part.messageId,
          sessionID: sessionId,
        };
      }),
    } as unknown as OpenCodeMessage;
  });
}

export interface SessionStore {
  readonly sessions: readonly SessionRow[];
  sessionUpdatedAt(sessionId: string): number | undefined;
  sessionMessages(sessionId: string): OpenCodeMessage[];
}

export function createSqliteSessionStore(sqlitePath: string): SessionStore {
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const sessions = sqlite
    .prepare(SESSION_QUERY)
    .all() as unknown as SessionRow[];
  const sessionStatusStatement = sqlite.prepare(SESSION_STATUS_QUERY);
  const messageStatement = sqlite.prepare(MESSAGE_QUERY);
  const partStatement = sqlite.prepare(PART_QUERY);

  return {
    sessions,
    sessionUpdatedAt(sessionId) {
      const row = sessionStatusStatement.get(sessionId) as
        | { timeUpdated?: unknown }
        | undefined;
      return row ? Number(row.timeUpdated) : undefined;
    },
    sessionMessages(sessionId) {
      const messageRows = messageStatement.all(
        sessionId,
      ) as unknown as MessageRow[];
      const partRows = partStatement.all(sessionId) as unknown as PartRow[];
      return hydrateSessionMessages(sessionId, messageRows, partRows);
    },
  };
}

export type StableSessionSnapshot =
  | { ready: false; retryAt: number }
  | {
      ready: true;
      messages: OpenCodeMessage[];
      observedUpdatedAt?: number;
    };

export function stableSessionSnapshot(
  session: Pick<SessionRow, "id">,
  store: Pick<SessionStore, "sessionUpdatedAt" | "sessionMessages">,
  clock: Pick<Clock, "nowMs"> = SYSTEM_CLOCK,
  inactiveMs = INACTIVE_MS,
): StableSessionSnapshot {
  const beforeUpdatedAt = store.sessionUpdatedAt(session.id);
  if (beforeUpdatedAt === undefined) return { ready: true, messages: [] };
  if (beforeUpdatedAt + inactiveMs > clock.nowMs()) {
    return { ready: false, retryAt: beforeUpdatedAt + inactiveMs };
  }

  const messages = store.sessionMessages(session.id);
  const afterUpdatedAt = store.sessionUpdatedAt(session.id);
  if (afterUpdatedAt === undefined) return { ready: true, messages: [] };
  if (
    afterUpdatedAt !== beforeUpdatedAt ||
    afterUpdatedAt + inactiveMs > clock.nowMs()
  ) {
    return { ready: false, retryAt: afterUpdatedAt + inactiveMs };
  }
  return { ready: true, messages, observedUpdatedAt: afterUpdatedAt };
}

export function sessionRemainsStable(
  sessionId: string,
  observedUpdatedAt: number,
  store: Pick<SessionStore, "sessionUpdatedAt">,
  clock: Pick<Clock, "nowMs"> = SYSTEM_CLOCK,
  inactiveMs = INACTIVE_MS,
): boolean {
  const currentUpdatedAt = store.sessionUpdatedAt(sessionId);
  return (
    currentUpdatedAt !== undefined &&
    currentUpdatedAt === observedUpdatedAt &&
    observedUpdatedAt + inactiveMs <= clock.nowMs()
  );
}

interface CanonicalBoundary {
  id: string;
  start_user_message_id: string;
  end_user_message_id: string;
  source_boundary_version: 1 | 2;
  start_source_message_id: string | null;
  end_source_message_id: string | null;
}

export function sourceSpanKey(value: CanonicalBoundary): string {
  return JSON.stringify([
    value.id,
    value.start_user_message_id,
    value.end_user_message_id,
    value.source_boundary_version,
    value.start_source_message_id,
    value.end_source_message_id,
  ]);
}

function segmentIdForBoundary(
  sessionId: string,
  boundary: Omit<CanonicalBoundary, "id">,
): string {
  if (boundary.source_boundary_version === 1) {
    return segmentIdForRequest({
      session_id: sessionId,
      start_user_message_id: boundary.start_user_message_id,
      source_boundary_version: 1,
      start_source_message_id: null,
    });
  }
  if (boundary.start_source_message_id === null) {
    throw new Error("V2 manifest boundary is missing its start source cursor");
  }
  return segmentIdForRequest({
    session_id: sessionId,
    start_user_message_id: boundary.start_user_message_id,
    source_boundary_version: 2,
    start_source_message_id: boundary.start_source_message_id,
  });
}

function canonicalBoundary(value: {
  id: string;
  start_user_message_id: string;
  end_user_message_id: string;
  source_boundary_version: 1 | 2;
  start_source_message_id: string | null;
  end_source_message_id: string | null;
}): CanonicalBoundary {
  return {
    id: value.id,
    start_user_message_id: value.start_user_message_id,
    end_user_message_id: value.end_user_message_id,
    source_boundary_version: value.source_boundary_version,
    start_source_message_id: value.start_source_message_id,
    end_source_message_id: value.end_source_message_id,
  };
}

function committedBoundary(
  value: SegmentBoundary | SegmentTargetBoundary,
): CommittedSegmentBoundary {
  const common = {
    id: value.id,
    startUserMessageId: value.start_user_message_id,
    endUserMessageId: value.end_user_message_id,
    projectionVersion: value.projection_version,
    sourceEligible: "source_eligible" in value && value.source_eligible,
    sourceFingerprint: value.source_fingerprint ?? undefined,
  };
  return value.source_boundary_version === 1
    ? {
        ...common,
        sourceBoundaryVersion: 1,
        startSourceMessageId: null,
        endSourceMessageId: null,
      }
    : {
        ...common,
        sourceBoundaryVersion: 2,
        startSourceMessageId: value.start_source_message_id,
        endSourceMessageId: value.end_source_message_id,
      };
}

export function segmentSubmission(
  sessionId: string,
  segment: ReflectionSegment,
): SegmentCreate {
  const common = {
    session_id: sessionId,
    start_user_message_id: segment.startUserMessageId,
    end_user_message_id: segment.endUserMessageId,
    projection_version: PROJECTION_VERSION,
    processing_priority: 0,
    messages: segment.messages,
  } as const;
  if (segment.sourceBoundaryVersion === 1) {
    if (
      segment.startSourceMessageId !== null ||
      segment.endSourceMessageId !== null
    ) {
      throw new Error("V1 segment contains source cursors");
    }
    return {
      ...common,
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
    };
  }
  if (
    segment.startSourceMessageId === null ||
    segment.endSourceMessageId === null
  ) {
    throw new Error("V2 segment is missing source cursors");
  }
  return parseSegmentCreate({
    ...common,
    source_boundary_version: 2,
    start_source_message_id: segment.startSourceMessageId,
    end_source_message_id: segment.endSourceMessageId,
  });
}

export function validateSegmentManifest(
  value: unknown,
  sessionId: string,
): SegmentManifest {
  const manifest = parseSessionSegmentsResponse(value);
  if (manifest.session_id !== sessionId) {
    throw new Error(
      `invalid segment manifest for ${sessionId}: response session_id was ${manifest.session_id}`,
    );
  }
  for (const anchor of [
    ...manifest.segments,
    ...manifest.boundaries,
    ...manifest.targets,
  ]) {
    const boundary = canonicalBoundary(anchor);
    const expectedId = segmentIdForBoundary(sessionId, boundary);
    if (anchor.id !== expectedId) {
      throw new Error(
        `invalid segment manifest for ${sessionId}: segment ${anchor.id} has non-deterministic identity`,
      );
    }
  }
  return manifest;
}

export function planSessionSegments(
  sessionId: string,
  messages: readonly OpenCodeMessage[],
  manifest: SegmentManifest,
  maxSegmentChars = MAX_SEGMENT_CHARS,
): PlannedSegment[] {
  const anchors = [...manifest.boundaries, ...manifest.targets].map(
    committedBoundary,
  );
  let segments: ReflectionSegment[];
  try {
    segments = segmentMessages(messages, maxSegmentChars, anchors);
  } catch (error) {
    throw new Error(
      `invalid segment manifest for ${sessionId}: ${errorText(error)}`,
      { cause: error },
    );
  }

  const planned = segments.map((segment): PlannedSegment => {
    const submission = segmentSubmission(sessionId, segment);
    const segmentId = segmentIdForRequest(submission);
    const localFingerprint = sourceFingerprint(submission);
    const key = sourceSpanKey({
      id: segmentId,
      start_user_message_id: submission.start_user_message_id,
      end_user_message_id: submission.end_user_message_id,
      source_boundary_version: submission.source_boundary_version,
      start_source_message_id: submission.start_source_message_id,
      end_source_message_id: submission.end_source_message_id,
    });
    const boundaries = manifest.boundaries.filter(
      (boundary) => sourceSpanKey(canonicalBoundary(boundary)) === key,
    );
    const targets = manifest.targets.filter(
      (target) => sourceSpanKey(canonicalBoundary(target)) === key,
    );
    const drifts: SegmentPlanDrift[] = [];
    let status: SegmentPlanStatus = "new";
    let manifestSourceFingerprint: string | null = null;
    let targetStatus: JobStatus | null = null;

    if (targets.length > 0) {
      const target = targets[0]!;
      if (target.status === "superseded") {
        throw new Error(
          `invalid segment manifest for ${sessionId}: current target ${target.id} is superseded`,
        );
      }
      manifestSourceFingerprint = target.source_fingerprint;
      targetStatus = target.status;
      if (targets.length > 1) drifts.push("conflicting_manifest_entries");
      if (target.source_fingerprint !== localFingerprint) {
        drifts.push("source_fingerprint_mismatch");
      }
      if (target.projection_version !== PROJECTION_VERSION) {
        drifts.push("projection_version_mismatch");
      }
      status =
        drifts.length > 0
          ? "conflicting"
          : (`target_${target.status}` as const);
    } else if (boundaries.length > 0) {
      const boundary = [...boundaries].sort(
        (left, right) =>
          Number(right.source_eligible) - Number(left.source_eligible) ||
          right.projection_version - left.projection_version,
      )[0]!;
      manifestSourceFingerprint = boundary.source_fingerprint;
      if (boundaries.length > 1) drifts.push("conflicting_manifest_entries");
      if (boundary.source_fingerprint === null) {
        drifts.push("missing_manifest_fingerprint");
      } else if (boundary.source_fingerprint !== localFingerprint) {
        drifts.push("source_fingerprint_mismatch");
      }
      if (boundary.projection_version !== PROJECTION_VERSION) {
        drifts.push("projection_version_mismatch");
      }
      status =
        boundary.source_eligible && drifts.length === 0
          ? "eligible_committed"
          : "stale_committed";
    }

    return {
      ...segment,
      segmentId,
      sourceFingerprint: localFingerprint,
      submission,
      serializedSubmission: JSON.stringify(submission),
      status,
      drifts,
      manifestSourceFingerprint,
      targetStatus,
      disposition: isSafeSegmentSnapshot(segment, messages)
        ? "ready"
        : "deferred_mutable_source",
    };
  });
  const plannedKeys = new Set(
    planned.map((segment) =>
      sourceSpanKey({
        id: segment.segmentId,
        start_user_message_id: segment.submission.start_user_message_id,
        end_user_message_id: segment.submission.end_user_message_id,
        source_boundary_version: segment.submission.source_boundary_version,
        start_source_message_id: segment.submission.start_source_message_id,
        end_source_message_id: segment.submission.end_source_message_id,
      }),
    ),
  );
  const unmatchedTargets = manifest.targets.filter(
    (target) => !plannedKeys.has(sourceSpanKey(canonicalBoundary(target))),
  );
  if (unmatchedTargets.length > 0) {
    throw new Error(
      `invalid segment manifest for ${sessionId}: ${unmatchedTargets.length} target(s) have no local source span`,
    );
  }
  return planned;
}

export function validatedJob(value: unknown): ReflectionJob {
  return parseJobResponse(value);
}

export function isProviderBalanceFailure(job: ReflectionJob): boolean {
  return (
    job.status === "failed" &&
    String(job.error).includes("402 Payment Required")
  );
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface FetchJsonDependencies {
  fetchImpl?: typeof globalThis.fetch;
  sleep?: Sleep;
  jobPollMs?: number;
  requestTimeoutMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface FetchJsonResult {
  response: Response;
  body: unknown;
}

export async function fetchJson(
  url: string,
  init: RequestInit = {},
  attempts = 5,
  dependencies: FetchJsonDependencies = {},
): Promise<FetchJsonResult> {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const wait = dependencies.sleep ?? sleep;
  const jobPollMs = dependencies.jobPollMs ?? DEFAULT_JOB_POLL_MS;
  const requestTimeoutMs =
    dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const setTimeoutImpl = dependencies.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl ?? clearTimeout;
  if (
    !Number.isFinite(requestTimeoutMs) ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0
  ) {
    throw new Error("request timeout must be a positive finite integer");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeoutImpl(() => {
      controller.abort(
        new Error(`Reflection request timed out after ${requestTimeoutMs}ms`),
      );
    }, requestTimeoutMs);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
    try {
      const signal = init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;
      const response = await fetchImpl(url, { ...init, signal });
      const text = await response.text();
      let body: unknown = text;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {}
      }
      return { response, body };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeoutImpl(timeout);
    }
    if (attempt < attempts) await wait(jobPollMs);
  }
  throw lastError;
}

export class ReflectionHttpError extends Error {
  readonly path: string;
  readonly status: number;
  readonly body: unknown;

  constructor(path: string, status: number, body: unknown) {
    super(`Reflection ${path} returned ${status}: ${JSON.stringify(body)}`);
    this.name = "ReflectionHttpError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

export class SessionRevisionChangedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session ${sessionId} changed during backfill`);
    this.name = "SessionRevisionChangedError";
    this.sessionId = sessionId;
  }
}

export class SessionReplanRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionReplanRequiredError";
  }
}

export class SessionPlanningError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, cause: unknown) {
    super(
      `session ${sessionId} has an invalid segment plan: ${errorText(cause)}`,
      {
        cause,
      },
    );
    this.name = "SessionPlanningError";
    this.sessionId = sessionId;
  }
}

export class SupersededJobError extends SessionReplanRequiredError {
  readonly jobId: number;

  constructor(jobId: number) {
    super(`job ${jobId} was superseded by a newer segment snapshot`);
    this.name = "SupersededJobError";
    this.jobId = jobId;
  }
}

async function runRevalidation(
  revalidate: Revalidate | undefined,
): Promise<void> {
  await revalidate?.();
}

async function waitWithRevalidation(
  milliseconds: number,
  wait: Sleep,
  revalidate: Revalidate | undefined,
): Promise<void> {
  await runRevalidation(revalidate);
  await wait(milliseconds);
  await runRevalidation(revalidate);
}

export type ServiceRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

export interface ReflectionService {
  request(
    path: string,
    init?: ServiceRequestInit,
    attempts?: number,
    revalidate?: Revalidate,
  ): Promise<unknown>;
  getJob(jobId: number, revalidate?: Revalidate): Promise<ReflectionJob>;
  retryJob(jobId: number, revalidate?: Revalidate): Promise<ReflectionJob>;
  waitForJob(
    job: ReflectionJob,
    revalidate?: Revalidate,
  ): Promise<ReflectionJob>;
}

export interface ReflectionServiceOptions {
  url: string;
  headers: Record<string, string>;
  jobPollMs: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleep?: Sleep;
  log?: Log;
}

export function createReflectionService(
  options: ReflectionServiceOptions,
): ReflectionService {
  const wait = options.sleep ?? sleep;
  const logger = options.log ?? (() => undefined);
  const fetchDependencies: FetchJsonDependencies = {
    fetchImpl: options.fetchImpl,
    sleep: wait,
    jobPollMs: options.jobPollMs,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };

  const request: ReflectionService["request"] = async (
    path,
    init = {},
    attempts = 5,
    revalidate,
  ) => {
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let result: FetchJsonResult;
      try {
        await runRevalidation(revalidate);
        result = await fetchJson(
          `${options.url}${path}`,
          {
            ...init,
            headers: { ...options.headers, ...init.headers },
          },
          1,
          fetchDependencies,
        );
        await runRevalidation(revalidate);
      } catch (error) {
        if (
          error instanceof SessionRevisionChangedError ||
          error instanceof SessionReplanRequiredError
        ) {
          throw error;
        }
        lastFailure = error;
        if (attempt < attempts) {
          await waitWithRevalidation(
            options.jobPollMs * 2 ** (attempt - 1),
            wait,
            revalidate,
          );
        }
        continue;
      }

      const { response, body } = result;
      if (response.ok) return body;
      lastFailure = new ReflectionHttpError(path, response.status, body);
      if (response.status !== 429 && response.status < 500) throw lastFailure;
      if (attempt < attempts) {
        await waitWithRevalidation(
          options.jobPollMs * 2 ** (attempt - 1),
          wait,
          revalidate,
        );
      }
    }
    throw lastFailure;
  };

  const getJob = async (
    jobId: number,
    revalidate?: Revalidate,
  ): Promise<ReflectionJob> =>
    validatedJob(await request(`/v1/jobs/${jobId}`, {}, 5, revalidate));

  const retryJob = async (
    jobId: number,
    revalidate?: Revalidate,
  ): Promise<ReflectionJob> => {
    let retryFailure: unknown;
    try {
      await runRevalidation(revalidate);
      const { response, body } = await fetchJson(
        `${options.url}/v1/jobs/${jobId}/retry`,
        { method: "POST", headers: options.headers },
        1,
        fetchDependencies,
      );
      await runRevalidation(revalidate);
      if (response.ok) return validatedJob(body);
      if (response.status === 404) throw new SupersededJobError(jobId);
      if (response.status !== 409) {
        throw new ReflectionHttpError(
          `/v1/jobs/${jobId}/retry`,
          response.status,
          body,
        );
      }
      retryFailure = new SupersededJobError(jobId);
    } catch (error) {
      if (error instanceof SupersededJobError) throw error;
      if (
        error instanceof SessionRevisionChangedError ||
        error instanceof SessionReplanRequiredError
      ) {
        throw error;
      }
      retryFailure = error;
      logger("job retry response was ambiguous", {
        jobId,
        error: errorText(error),
      });
    }
    let current: ReflectionJob;
    try {
      current = await getJob(jobId, revalidate);
    } catch (error) {
      if (error instanceof ReflectionHttpError && error.status === 404) {
        throw new SupersededJobError(jobId);
      }
      throw error;
    }
    if (["pending", "running", "succeeded"].includes(current.status)) {
      return current;
    }
    if (retryFailure instanceof SupersededJobError) throw retryFailure;
    throw new Error(`job ${jobId} remained failed after retry request`, {
      cause: retryFailure,
    });
  };

  const waitForJob = async (
    job: ReflectionJob,
    revalidate?: Revalidate,
  ): Promise<ReflectionJob> => {
    let current = validatedJob(job);
    while (current.status === "pending" || current.status === "running") {
      await waitWithRevalidation(options.jobPollMs, wait, revalidate);
      current = await getJob(current.id, revalidate);
    }
    return current;
  };

  return { request, getJob, retryJob, waitForJob };
}

export interface CompleteJobContext {
  state: BackfillState;
  retryJob(jobId: number): Promise<ReflectionJob>;
  waitForJob(job: ReflectionJob): Promise<ReflectionJob>;
  saveState(): void;
  log: Log;
  sleep: Sleep;
  clock: Pick<Clock, "nowMs">;
  providerPollMs: number;
  jobPollMs?: number;
  maxNonProviderJobRounds?: number;
  validateJob?(job: ReflectionJob): void;
  revalidateSession?: Revalidate;
  revalidateExpectedSnapshot?(job: ReflectionJob): void | Promise<void>;
}

export function jobSourceDetails(job: ReflectionJob): Record<string, unknown> {
  return {
    jobId: job.id,
    segmentId: job.segment_id,
    startUserMessageId: job.start_user_message_id,
    endUserMessageId: job.end_user_message_id,
    sourceBoundaryVersion: job.source_boundary_version,
    startSourceMessageId: job.start_source_message_id,
    endSourceMessageId: job.end_source_message_id,
    sourceFingerprint: job.source_fingerprint,
  };
}

export function validateJobForSubmission(
  job: ReflectionJob,
  submission: SegmentCreate,
): ReflectionJob {
  const expectedSegmentId = segmentIdForRequest(submission);
  const expectedFingerprint = sourceFingerprint(submission);
  if (
    job.segment_id !== expectedSegmentId ||
    job.start_user_message_id !== submission.start_user_message_id ||
    job.end_user_message_id !== submission.end_user_message_id ||
    job.source_boundary_version !== submission.source_boundary_version ||
    job.start_source_message_id !== submission.start_source_message_id ||
    job.end_source_message_id !== submission.end_source_message_id ||
    job.source_fingerprint !== expectedFingerprint
  ) {
    throw new SessionReplanRequiredError(
      `job ${job.id} does not match submitted segment ${expectedSegmentId}`,
    );
  }
  return job;
}

async function revalidateJobContext(
  context: CompleteJobContext,
  job: ReflectionJob,
): Promise<void> {
  await runRevalidation(context.revalidateSession);
  await context.revalidateExpectedSnapshot?.(job);
  await runRevalidation(context.revalidateSession);
}

async function waitForProvider(
  context: CompleteJobContext,
  job: ReflectionJob,
): Promise<void> {
  let remaining = context.providerPollMs;
  const interval = Math.min(
    context.jobPollMs ?? DEFAULT_JOB_POLL_MS,
    context.providerPollMs,
  );
  while (remaining > 0) {
    const duration = Math.min(interval, remaining);
    await waitWithRevalidation(
      duration,
      context.sleep,
      context.revalidateSession,
    );
    remaining -= duration;
  }
  await revalidateJobContext(context, job);
}

export async function completeJob(
  job: ReflectionJob,
  context: CompleteJobContext,
): Promise<ReflectionJob> {
  let current = validatedJob(job);
  let nonProviderRounds = 0;
  let providerFailures = 0;
  const maxNonProviderJobRounds =
    context.maxNonProviderJobRounds ?? MAX_NON_PROVIDER_JOB_ROUNDS;
  context.validateJob?.(current);

  while (true) {
    if (current.status === "succeeded") {
      await revalidateJobContext(context, current);
      if (Object.keys(context.state.providerStatus).length > 0) {
        context.state.providerStatus = {};
        context.state.status = "running";
        context.saveState();
      }
      return current;
    }
    if (current.status === "superseded") {
      throw new SupersededJobError(current.id);
    }
    if (current.status === "failed") {
      await revalidateJobContext(context, current);
      if (isProviderBalanceFailure(current)) {
        if (providerFailures > 0) {
          const providerStatus: ProviderStatus = {
            jobId: current.id,
            segmentId: current.segment_id,
            sourceBoundaryVersion: current.source_boundary_version,
            startSourceMessageId: current.start_source_message_id,
            endSourceMessageId: current.end_source_message_id,
            sourceFingerprint: current.source_fingerprint,
            error: current.error,
            nextRetryAt: new Date(
              context.clock.nowMs() + context.providerPollMs,
            ).toISOString(),
          };
          context.state.status = "waiting_for_provider";
          context.state.providerStatus = providerStatus;
          context.saveState();
          context.log("model provider remains unavailable", {
            ...jobSourceDetails(current),
            nextRetryAt: providerStatus.nextRetryAt,
          });
          try {
            await waitForProvider(context, current);
          } finally {
            context.state.status = "running";
            context.state.providerStatus = {};
            context.saveState();
          }
        }
        providerFailures += 1;
      } else {
        nonProviderRounds += 1;
        if (nonProviderRounds >= maxNonProviderJobRounds) {
          await revalidateJobContext(context, current);
          return current;
        }
      }
      context.log("retrying failed segment job", jobSourceDetails(current));
      current = await context.retryJob(current.id);
      context.validateJob?.(current);
      await runRevalidation(context.revalidateSession);
    }
    await runRevalidation(context.revalidateSession);
    current = await context.waitForJob(current);
    context.validateJob?.(current);
    await runRevalidation(context.revalidateSession);
  }
}

export function acquireLock(
  lockPath: string,
  processId = process.pid,
  kill: (pid: number, signal: 0) => true = process.kill,
): void {
  if (existsSync(lockPath)) {
    try {
      const existingPid = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(existingPid) && existingPid > 0) {
        kill(existingPid, 0);
        throw new Error(
          `backfill worker is already running as PID ${existingPid}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("already running")) {
        throw error;
      }
      unlinkSync(lockPath);
    }
  }
  const descriptor = openSync(lockPath, "wx", 0o600);
  writeFileSync(descriptor, `${processId}\n`);
  closeSync(descriptor);
}

export function releaseLock(lockPath: string, processId = process.pid): void {
  try {
    if (readFileSync(lockPath, "utf8").trim() === String(processId)) {
      unlinkSync(lockPath);
    }
  } catch {}
}

export function cleanupLaunchAgentCommand(
  moduleDirectory: string,
  label: string,
  plist: string,
  stateDirectory: string,
): { command: string; arguments: string[] } {
  return {
    command: process.execPath,
    arguments: [
      join(moduleDirectory, "..", "cleanup-launch-agent.mjs"),
      label,
      plist,
      join(stateDirectory, "cleanup.json"),
    ],
  };
}

interface ReflectionConfig {
  url: string;
  apiKey: string;
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function createLogger(clock: Pick<Clock, "nowIso">): Log {
  return (message, details = {}) => {
    console.log(logLine(clock.nowIso(), message, details));
  };
}

function createSaveState(
  state: BackfillState,
  options: Pick<BackfillOptions, "dryRun" | "statePath">,
  processId: number,
  clock: Pick<Clock, "nowIso">,
): () => void {
  return () => {
    if (options.dryRun) return;
    state.updatedAt = clock.nowIso();
    const temporaryPath = `${options.statePath}.${processId}.tmp`;
    writeFileSync(temporaryPath, serializeState(state), { mode: 0o600 });
    renameSync(temporaryPath, options.statePath);
  };
}

export async function segmentPlan(
  sessionId: string,
  messages: readonly OpenCodeMessage[],
  service: Pick<ReflectionService, "request">,
  revalidate?: Revalidate,
): Promise<PlannedSegment[]> {
  const response = await service.request(
    `/v1/sessions/${encodeURIComponent(sessionId)}/segments`,
    {},
    5,
    revalidate,
  );
  try {
    return planSessionSegments(
      sessionId,
      messages,
      validateSegmentManifest(response, sessionId),
    );
  } catch (error) {
    throw new SessionPlanningError(sessionId, error);
  }
}

export interface DryRunPlanningFailure {
  sessionId: string;
  error: string;
}

export interface DryRunSummary {
  sessions: number;
  stableSessions: number;
  deferredSessions: number;
  expiredDeferredSessions: number;
  invalidSessions: number;
  segments: number;
  messages: number;
  statuses: Record<DryRunStatus, number>;
  dispositions: Record<SegmentPlanDisposition, number>;
  drifts: Record<SegmentPlanDrift, number>;
  planningFailures: DryRunPlanningFailure[];
}

export async function createDryRunSummary(
  sessions: readonly SessionRow[],
  store: SessionStore,
  service: Pick<ReflectionService, "request">,
  clock: Pick<Clock, "nowMs"> = SYSTEM_CLOCK,
  maxMutableSourceDeferralMs = DEFAULT_MAX_MUTABLE_SOURCE_DEFERRAL_MS,
): Promise<DryRunSummary> {
  let segmentCount = 0;
  let messageCount = 0;
  let deferredSessions = 0;
  let expiredDeferredSessions = 0;
  let invalidSessions = 0;
  const statuses: Record<DryRunStatus, number> = {
    eligible_committed: 0,
    stale_committed: 0,
    target_pending: 0,
    target_running: 0,
    target_succeeded: 0,
    target_failed: 0,
    target_superseded: 0,
    conflicting: 0,
    new: 0,
    invalid: 0,
  };
  const dispositions: Record<SegmentPlanDisposition, number> = {
    ready: 0,
    deferred_mutable_source: 0,
  };
  const drifts: Record<SegmentPlanDrift, number> = {
    missing_manifest_fingerprint: 0,
    source_fingerprint_mismatch: 0,
    projection_version_mismatch: 0,
    conflicting_manifest_entries: 0,
  };
  const planningFailures: DryRunPlanningFailure[] = [];
  for (const session of sessions) {
    const snapshot = stableSessionSnapshot(session, store, clock);
    if (!snapshot.ready) {
      deferredSessions += 1;
      continue;
    }
    let segments: PlannedSegment[];
    try {
      segments = await segmentPlan(session.id, snapshot.messages, service);
    } catch (error) {
      if (
        snapshot.observedUpdatedAt !== undefined &&
        !sessionRemainsStable(
          session.id,
          snapshot.observedUpdatedAt,
          store,
          clock,
        )
      ) {
        deferredSessions += 1;
        continue;
      }
      if (!(error instanceof SessionPlanningError)) throw error;
      invalidSessions += 1;
      statuses.invalid += 1;
      planningFailures.push({
        sessionId: session.id,
        error: errorText(error),
      });
      continue;
    }
    if (
      snapshot.observedUpdatedAt !== undefined &&
      !sessionRemainsStable(
        session.id,
        snapshot.observedUpdatedAt,
        store,
        clock,
      )
    ) {
      deferredSessions += 1;
      continue;
    }
    segmentCount += segments.length;
    if (
      segments.some(
        (segment) => segment.disposition === "deferred_mutable_source",
      )
    ) {
      if (
        snapshot.observedUpdatedAt !== undefined &&
        clock.nowMs() - snapshot.observedUpdatedAt >= maxMutableSourceDeferralMs
      ) {
        expiredDeferredSessions += 1;
      } else {
        deferredSessions += 1;
      }
    }
    for (const segment of segments) {
      statuses[segment.status] += 1;
      dispositions[segment.disposition] += 1;
      for (const drift of segment.drifts) drifts[drift] += 1;
    }
    messageCount += segments.reduce(
      (total, segment) => total + segment.messages.length,
      0,
    );
  }
  return {
    sessions: sessions.length,
    stableSessions: sessions.length - deferredSessions,
    deferredSessions,
    expiredDeferredSessions,
    invalidSessions,
    segments: segmentCount,
    messages: messageCount,
    statuses,
    dispositions,
    drifts,
    planningFailures,
  };
}

export interface ProcessingContext {
  state: BackfillState;
  sessions: readonly SessionRow[];
  store: SessionStore;
  service: ReflectionService;
  saveState(): void;
  log: Log;
  sleep: Sleep;
  clock: Clock;
  providerPollMs: number;
  jobPollMs: number;
  priorityJobIds: readonly number[];
  completedSnapshots: Set<string>;
  attemptedSnapshots: Set<string>;
  maxMutableSourceDeferralMs: number;
  allowFailures: boolean;
  acquireLock(): void;
  releaseLock(): void;
  scheduleLaunchAgentCleanup(): void | Promise<void>;
}

function recordFailure(
  context: ProcessingContext,
  sessionId: string | null,
  segment: PlannedSegment | null,
  job: Pick<ReflectionJob, "id" | "error"> | null,
  error?: unknown,
): void {
  recordFailureInState(context.state, sessionId, segment, job, error);
  context.saveState();
}

function completeJobWithContext(
  job: ReflectionJob,
  context: ProcessingContext,
  segment?: PlannedSegment,
  revalidateSession?: Revalidate,
): Promise<ReflectionJob> {
  return completeJob(job, {
    state: context.state,
    retryJob: (jobId) => context.service.retryJob(jobId, revalidateSession),
    waitForJob: (current) =>
      context.service.waitForJob(current, revalidateSession),
    saveState: context.saveState,
    log: context.log,
    sleep: context.sleep,
    clock: context.clock,
    providerPollMs: context.providerPollMs,
    jobPollMs: context.jobPollMs,
    validateJob: segment
      ? (current) => validateJobForSubmission(current, segment.submission)
      : undefined,
    revalidateSession,
    revalidateExpectedSnapshot: segment
      ? (current) =>
          revalidateExpectedSnapshot(
            context,
            segment,
            current,
            revalidateSession,
          )
      : undefined,
  });
}

export async function processPriorityJobs(
  context: ProcessingContext,
): Promise<void> {
  for (const jobId of context.priorityJobIds) {
    try {
      const job = await context.service.getJob(jobId);
      const snapshotKey = job.source_fingerprint
        ? `${job.segment_id}:${job.source_fingerprint}:${PROJECTION_VERSION}`
        : null;
      if (job.status === "succeeded") {
        if (snapshotKey) context.completedSnapshots.add(snapshotKey);
        continue;
      }
      context.log("processing retained priority job", {
        ...jobSourceDetails(job),
        status: job.status,
      });
      const completed = await completeJobWithContext(job, context);
      if (completed.status !== "succeeded") {
        if (snapshotKey) context.attemptedSnapshots.add(snapshotKey);
        recordFailure(context, null, null, completed);
      } else if (snapshotKey) {
        context.completedSnapshots.add(snapshotKey);
      }
    } catch (error) {
      if (
        error instanceof SupersededJobError ||
        (error instanceof ReflectionHttpError && error.status === 404)
      ) {
        context.log("retained priority job is no longer available", {
          jobId,
          error: errorText(error),
        });
        continue;
      }
      throw error;
    }
  }
}

function plannedSegmentDetails(
  segment: PlannedSegment,
): Record<string, unknown> {
  return {
    segmentId: segment.segmentId,
    startUserMessageId: segment.startUserMessageId,
    endUserMessageId: segment.endUserMessageId,
    sourceBoundaryVersion: segment.sourceBoundaryVersion,
    startSourceMessageId: segment.startSourceMessageId,
    endSourceMessageId: segment.endSourceMessageId,
    sourceFingerprint: segment.sourceFingerprint,
    planStatus: segment.status,
    disposition: segment.disposition,
    targetStatus: segment.targetStatus,
    drifts: segment.drifts,
  };
}

export function manifestHasExpectedSnapshot(
  manifest: SegmentManifest,
  segment: PlannedSegment,
  allowCommitted: boolean,
  committedProjectionVersion: number = segment.submission.projection_version,
): boolean {
  const expectedKey = sourceSpanKey({
    id: segment.segmentId,
    start_user_message_id: segment.submission.start_user_message_id,
    end_user_message_id: segment.submission.end_user_message_id,
    source_boundary_version: segment.submission.source_boundary_version,
    start_source_message_id: segment.submission.start_source_message_id,
    end_source_message_id: segment.submission.end_source_message_id,
  });
  const targetMatches = manifest.targets.some(
    (target) =>
      sourceSpanKey(canonicalBoundary(target)) === expectedKey &&
      target.source_fingerprint === segment.sourceFingerprint &&
      target.projection_version === segment.submission.projection_version,
  );
  if (targetMatches) return true;
  return (
    allowCommitted &&
    manifest.boundaries.some(
      (boundary) =>
        sourceSpanKey(canonicalBoundary(boundary)) === expectedKey &&
        boundary.source_fingerprint === segment.sourceFingerprint &&
        boundary.projection_version === committedProjectionVersion &&
        boundary.source_eligible,
    )
  );
}

async function revalidateExpectedSnapshot(
  context: ProcessingContext,
  segment: PlannedSegment,
  job: ReflectionJob,
  revalidateSession: Revalidate | undefined,
): Promise<void> {
  await runRevalidation(revalidateSession);
  const response = await context.service.request(
    `/v1/sessions/${encodeURIComponent(segment.submission.session_id)}/segments`,
    {},
    5,
    revalidateSession,
  );
  const manifest = validateSegmentManifest(
    response,
    segment.submission.session_id,
  );
  await runRevalidation(revalidateSession);
  if (
    !manifestHasExpectedSnapshot(
      manifest,
      segment,
      job.status === "succeeded",
      job.projection_version,
    )
  ) {
    throw new SessionReplanRequiredError(
      `segment ${segment.segmentId} no longer has the expected source snapshot`,
    );
  }
}

export type ProcessSessionOutcome =
  | "completed"
  | "deferred"
  | "deferred_source"
  | "replan"
  | "failed";

export async function processSession(
  context: ProcessingContext,
  session: SessionRow,
  messages: readonly OpenCodeMessage[],
  observedUpdatedAt: number | undefined,
): Promise<ProcessSessionOutcome> {
  if (observedUpdatedAt === undefined) {
    context.state.sessionsVisited += 1;
    context.saveState();
    return "completed";
  }
  const revalidateSession = () => {
    if (
      !sessionRemainsStable(
        session.id,
        observedUpdatedAt,
        context.store,
        context.clock,
      )
    ) {
      throw new SessionRevisionChangedError(session.id);
    }
  };
  let activeSegment: PlannedSegment | null = null;
  try {
    revalidateSession();
    const segments = await segmentPlan(
      session.id,
      messages,
      context.service,
      revalidateSession,
    );
    revalidateSession();

    context.state.status = "running";
    context.state.currentSessionId = session.id;
    context.state.currentSessionTitle = session.title;
    let deferredSegment: PlannedSegment | null = null;
    for (const [segmentIndex, segment] of segments.entries()) {
      if (segment.disposition === "deferred_mutable_source") {
        deferredSegment = segment;
        break;
      }
      const completedSnapshotKey = `${segment.segmentId}:${segment.sourceFingerprint}:${segment.submission.projection_version}`;
      if (
        context.completedSnapshots.has(completedSnapshotKey) &&
        (segment.status === "eligible_committed" ||
          segment.status === "target_succeeded")
      ) {
        continue;
      }
      context.completedSnapshots.delete(completedSnapshotKey);
      if (
        context.attemptedSnapshots.has(completedSnapshotKey) &&
        segment.status === "target_failed"
      ) {
        continue;
      }
      context.attemptedSnapshots.delete(completedSnapshotKey);
      activeSegment = segment;
      context.state.segmentsDiscovered += 1;
      context.state.currentSegment = {
        index: segmentIndex,
        count: segments.length,
        segmentId: segment.segmentId,
        startUserMessageId: segment.startUserMessageId,
        endUserMessageId: segment.endUserMessageId,
        sourceBoundaryVersion: segment.sourceBoundaryVersion,
        startSourceMessageId: segment.startSourceMessageId,
        endSourceMessageId: segment.endSourceMessageId,
        sourceFingerprint: segment.sourceFingerprint,
        status: segment.status,
      };
      context.saveState();
      context.log("processing session segment", {
        sessionId: session.id,
        ...plannedSegmentDetails(segment),
      });
      revalidateSession();

      if (
        segment.status === "eligible_committed" ||
        segment.status === "target_succeeded"
      ) {
        context.state.segmentsAlreadySucceeded += 1;
        context.completedSnapshots.add(completedSnapshotKey);
        context.saveState();
        continue;
      }

      const submission: ServiceRequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: segment.serializedSubmission,
      };
      let job = validateJobForSubmission(
        validatedJob(
          await context.service.request(
            "/v1/segments",
            submission,
            5,
            revalidateSession,
          ),
        ),
        segment.submission,
      );
      let wasAlreadySucceeded = job.status === "succeeded";
      let completed = await completeJobWithContext(
        job,
        context,
        segment,
        revalidateSession,
      );
      let projectionUpgradeFailed = false;
      let projectionUpgradeReplays = 0;
      while (
        completed.status === "succeeded" &&
        completed.projection_version < PROJECTION_VERSION
      ) {
        if (projectionUpgradeReplays >= MAX_PROJECTION_UPGRADE_REPLAYS) {
          context.attemptedSnapshots.add(completedSnapshotKey);
          recordFailure(
            context,
            session.id,
            segment,
            completed,
            new Error(
              `projection upgrade did not reach version ${PROJECTION_VERSION}`,
            ),
          );
          projectionUpgradeFailed = true;
          break;
        }
        projectionUpgradeReplays += 1;
        revalidateSession();
        job = validateJobForSubmission(
          validatedJob(
            await context.service.request(
              "/v1/segments",
              submission,
              5,
              revalidateSession,
            ),
          ),
          segment.submission,
        );
        wasAlreadySucceeded = wasAlreadySucceeded && job.status === "succeeded";
        completed = await completeJobWithContext(
          job,
          context,
          segment,
          revalidateSession,
        );
      }
      if (projectionUpgradeFailed) {
        context.saveState();
        revalidateSession();
        continue;
      }
      if (completed.status === "succeeded") {
        if (wasAlreadySucceeded) context.state.segmentsAlreadySucceeded += 1;
        else context.state.segmentsSucceeded += 1;
        context.completedSnapshots.add(completedSnapshotKey);
      } else {
        context.attemptedSnapshots.add(completedSnapshotKey);
        recordFailure(context, session.id, segment, completed);
      }
      context.saveState();
      revalidateSession();
    }
    if (deferredSegment) {
      if (
        context.clock.nowMs() - observedUpdatedAt >=
        context.maxMutableSourceDeferralMs
      ) {
        context.state.segmentsDiscovered += 1;
        recordFailure(
          context,
          session.id,
          deferredSegment,
          null,
          new Error("mutable source span exceeded the safe deferral window"),
        );
        context.state.sessionsVisited += 1;
        context.state.currentSegment = null;
        context.saveState();
        return "failed";
      }
      context.state.currentSegment = null;
      context.saveState();
      context.log("session has a deferred mutable source span", {
        sessionId: session.id,
        segment: plannedSegmentDetails(deferredSegment),
      });
      return "deferred_source";
    }
    context.state.sessionsVisited += 1;
    context.saveState();
    return "completed";
  } catch (error) {
    if (error instanceof SessionRevisionChangedError) {
      context.log("session changed during processing; deferring", {
        sessionId: session.id,
        ...(activeSegment ? plannedSegmentDetails(activeSegment) : {}),
      });
      return "deferred";
    }
    if (
      error instanceof SessionReplanRequiredError ||
      (activeSegment &&
        error instanceof ReflectionHttpError &&
        error.status === 404)
    ) {
      context.log("segment target changed; replanning session", {
        sessionId: session.id,
        ...(activeSegment ? plannedSegmentDetails(activeSegment) : {}),
        error: errorText(error),
      });
      return "replan";
    }
    if (error instanceof SessionPlanningError) {
      context.log("session segment plan is invalid; skipping", {
        sessionId: session.id,
        error: errorText(error),
      });
      recordFailure(context, session.id, null, null, error);
      context.state.sessionsVisited += 1;
      context.saveState();
      return "failed";
    }
    throw error;
  }
}

export async function runBackfill(context: ProcessingContext): Promise<void> {
  context.acquireLock();
  try {
    context.saveState();
    context.state.status = "running";
    context.saveState();
    await processPriorityJobs(context);
    let queue: readonly SessionRow[] = context.sessions;
    while (queue.length > 0) {
      const deferred: Array<{ session: SessionRow; retryAt: number }> = [];
      for (const session of queue) {
        const snapshot = stableSessionSnapshot(
          session,
          context.store,
          context.clock,
        );
        if (!snapshot.ready) {
          deferred.push({ session, retryAt: snapshot.retryAt });
          continue;
        }
        const outcome = await processSession(
          context,
          session,
          snapshot.messages,
          snapshot.observedUpdatedAt,
        );
        if (
          outcome === "deferred" ||
          outcome === "deferred_source" ||
          outcome === "replan"
        ) {
          const currentUpdatedAt = context.store.sessionUpdatedAt(session.id);
          deferred.push({
            session,
            retryAt:
              outcome === "replan"
                ? context.clock.nowMs() + context.jobPollMs
                : outcome === "deferred_source"
                  ? context.clock.nowMs() + 60_000
                  : (currentUpdatedAt ?? context.clock.nowMs()) + INACTIVE_MS,
          });
        }
      }
      if (deferred.length === 0) break;
      const earliestRetryAt = Math.min(
        ...deferred.map(({ retryAt }) => retryAt),
      );
      const waitMs = Math.max(
        context.jobPollMs,
        Math.min(60_000, earliestRetryAt - context.clock.nowMs()),
      );
      context.state.status = "waiting_for_session_inactivity";
      context.state.currentSessionId = null;
      context.state.currentSessionTitle = null;
      context.state.currentSegment = null;
      context.state.deferredSessions = deferred.length;
      context.saveState();
      context.log("deferred active sessions", {
        count: deferred.length,
        nextCheckAt: new Date(context.clock.nowMs() + waitMs).toISOString(),
      });
      await context.sleep(waitMs);
      queue = deferred.map(({ session }) => session);
    }

    context.state.status = context.state.segmentsFailed
      ? "completed_with_failures"
      : "completed";
    context.state.completedAt = context.clock.nowIso();
    context.state.currentSessionId = null;
    context.state.currentSessionTitle = null;
    context.state.currentSegment = null;
    context.state.deferredSessions = 0;
    context.state.providerStatus = {};
    context.saveState();
    context.log("backfill completed", {
      sessionsVisited: context.state.sessionsVisited,
      segmentsSucceeded: context.state.segmentsSucceeded,
      segmentsAlreadySucceeded: context.state.segmentsAlreadySucceeded,
      segmentsFailed: context.state.segmentsFailed,
    });
    if (!context.state.segmentsFailed || context.allowFailures) {
      await context.scheduleLaunchAgentCleanup();
    }
  } catch (error) {
    context.state.status = "failed";
    context.state.fatalError = errorText(error);
    context.saveState();
    throw error;
  } finally {
    context.releaseLock();
  }
}

export async function main(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const options = resolveBackfillOptions(argv, environment);
  const clock = SYSTEM_CLOCK;
  const logger = createLogger(clock);
  const processId = process.pid;

  if (!options.dryRun) mkdirSync(options.stateDirectory, { recursive: true });

  let previousState: unknown = {};
  if (!options.dryRun && existsSync(options.statePath)) {
    try {
      previousState = loadJson(options.statePath);
    } catch {}
  }
  const state = createInitialState(previousState, clock.nowIso);
  const saveState = createSaveState(state, options, processId, clock);

  const store = createSqliteSessionStore(options.sqlitePath);
  const sessions = store.sessions;
  state.sessionsTotal = sessions.length;

  const reflectionConfig = loadJson(
    options.reflectionConfigPath,
  ) as ReflectionConfig;
  const service = createReflectionService({
    url: reflectionConfig.url,
    headers: { "X-Api-Key": reflectionConfig.apiKey },
    jobPollMs: options.jobPollMs,
    requestTimeoutMs: options.requestTimeoutMs,
    log: logger,
  });

  if (options.dryRun) {
    const summary = await createDryRunSummary(
      sessions,
      store,
      service,
      clock,
      options.maxMutableSourceDeferralMs,
    );
    console.log(JSON.stringify(summary));
    return summary.invalidSessions > 0 || summary.expiredDeferredSessions > 0
      ? 1
      : 0;
  }

  const release = () => releaseLock(options.lockPath, processId);
  const processingContext: ProcessingContext = {
    state,
    sessions,
    store,
    service,
    saveState,
    log: logger,
    sleep,
    clock,
    providerPollMs: options.providerPollMs,
    jobPollMs: options.jobPollMs,
    priorityJobIds: options.priorityJobIds,
    completedSnapshots: new Set(),
    attemptedSnapshots: new Set(),
    maxMutableSourceDeferralMs: options.maxMutableSourceDeferralMs,
    allowFailures: options.allowFailures,
    acquireLock: () => {
      acquireLock(options.lockPath, processId);
    },
    releaseLock: release,
    scheduleLaunchAgentCleanup: async () => {
      if (!options.launchdLabel || !options.launchdPlist) return;
      const command = cleanupLaunchAgentCommand(
        import.meta.dirname,
        options.launchdLabel,
        options.launchdPlist,
        options.stateDirectory,
      );
      const child = spawn(command.command, command.arguments, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      await new Promise<void>((resolve) => {
        child.once("error", (error) => {
          logger("failed to start LaunchAgent cleanup", {
            label: options.launchdLabel,
            error: errorText(error),
          });
          resolve();
        });
        child.once("spawn", () => {
          state.cleanup = {
            status: "scheduled",
            label: options.launchdLabel!,
            plist: options.launchdPlist!,
            scheduledAt: clock.nowIso(),
          };
          saveState();
          logger("scheduled LaunchAgent cleanup", {
            label: options.launchdLabel,
            plist: options.launchdPlist,
          });
          resolve();
        });
      });
    },
  };

  try {
    await runBackfill(processingContext);
    return state.segmentsFailed > 0 && !options.allowFailures ? 1 : 0;
  } catch (error) {
    logger("backfill worker failed", { error: errorText(error) });
    return 1;
  }
}

if (import.meta.main) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
