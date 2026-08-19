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
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const MAX_SEGMENT_CHARS = 20_000;
const PROJECTION_VERSION = 1;
const INACTIVE_MS = 10 * 60 * 1000;
const PROVIDER_POLL_MS = Number(
  process.env.REFLECTION_PROVIDER_POLL_MS ?? 5 * 60_000,
);
const JOB_POLL_MS = Number(process.env.REFLECTION_JOB_POLL_MS ?? 2_000);
const MAX_NON_PROVIDER_JOB_ROUNDS = 2;
const DRY_RUN = process.argv.includes("--dry-run");
const STATE_DIR =
  process.env.REFLECTION_BACKFILL_STATE_DIR ??
  join(HOME, ".local/state/reflection-backfill");
const STATE_PATH = join(STATE_DIR, "state.json");
const LOCK_PATH = join(STATE_DIR, "worker.lock");
const SQLITE_PATH =
  process.env.OPENCODE_DATABASE_PATH ??
  join(HOME, ".local/share/opencode/opencode.db");
const REFLECTION_CONFIG_PATH = join(HOME, ".config/opencode/reflection.json");
const LAUNCHD_LABEL = process.env.REFLECTION_BACKFILL_LAUNCHD_LABEL;
const LAUNCHD_PLIST = process.env.REFLECTION_BACKFILL_LAUNCHD_PLIST;
const PRIORITY_JOB_IDS = [7, 8];

function now() {
  return new Date().toISOString();
}

function log(message, details = {}) {
  console.log(JSON.stringify({ timestamp: now(), message, ...details }));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function errorText(error) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

if (!DRY_RUN) mkdirSync(STATE_DIR, { recursive: true });

let previousState = {};
if (!DRY_RUN && existsSync(STATE_PATH)) {
  try {
    previousState = loadJson(STATE_PATH);
  } catch {}
}

const state = {
  runCount: Number(previousState.runCount ?? 0) + 1,
  startedAt: now(),
  updatedAt: now(),
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

function saveState() {
  if (DRY_RUN) return;
  state.updatedAt = now();
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, STATE_PATH);
}

function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    try {
      const existingPid = Number(readFileSync(LOCK_PATH, "utf8").trim());
      if (Number.isInteger(existingPid) && existingPid > 0) {
        process.kill(existingPid, 0);
        throw new Error(
          `backfill worker is already running as PID ${existingPid}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("already running"))
        throw error;
      unlinkSync(LOCK_PATH);
    }
  }
  const descriptor = openSync(LOCK_PATH, "wx", 0o600);
  writeFileSync(descriptor, `${process.pid}\n`);
  closeSync(descriptor);
}

function releaseLock() {
  try {
    if (readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid))
      unlinkSync(LOCK_PATH);
  } catch {}
}

function scheduleLaunchAgentCleanup() {
  if (!LAUNCHD_LABEL || !LAUNCHD_PLIST) return;
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "cleanup-launch-agent.mjs"),
      LAUNCHD_LABEL,
      LAUNCHD_PLIST,
      join(STATE_DIR, "cleanup.json"),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", (error) => {
    log("failed to start LaunchAgent cleanup", {
      label: LAUNCHD_LABEL,
      error: errorText(error),
    });
  });
  child.unref();
  state.cleanup = {
    status: "scheduled",
    label: LAUNCHD_LABEL,
    plist: LAUNCHD_PLIST,
    scheduledAt: now(),
  };
  saveState();
  log("scheduled LaunchAgent cleanup", {
    label: LAUNCHD_LABEL,
    plist: LAUNCHD_PLIST,
  });
}

function segmentMessages(rows) {
  const turns = [];
  const turnsById = new Map();
  for (const [index, row] of rows.entries()) {
    if (row.role !== "user") continue;
    const turn = {
      userMessageId: row.id,
      charCount: row.text.length,
      messages: [{ index, role: "user", text: row.text }],
      complete: false,
    };
    turns.push(turn);
    turnsById.set(row.id, turn);
  }

  for (const [index, row] of rows.entries()) {
    if (row.role !== "assistant" || !row.parentId) continue;
    const turn = turnsById.get(row.parentId);
    if (!turn) continue;
    turn.messages.push({ index, role: "assistant", text: row.text });
    turn.charCount += row.text.length;
    if (
      !row.error &&
      typeof row.timeCompleted === "number" &&
      typeof row.finish === "string" &&
      !["tool-calls", "unknown"].includes(row.finish)
    ) {
      turn.complete = true;
    }
  }

  const segments = [];
  let current = [];
  let currentChars = 0;
  for (const turn of turns) {
    if (!turn.complete) {
      if (current.length) segments.push(current);
      current = [];
      currentChars = 0;
      continue;
    }
    if (turn.charCount > MAX_SEGMENT_CHARS) {
      if (current.length) segments.push(current);
      segments.push([turn]);
      current = [];
      currentChars = 0;
      continue;
    }
    if (current.length && currentChars + turn.charCount > MAX_SEGMENT_CHARS) {
      segments.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(turn);
    currentChars += turn.charCount;
    if (currentChars === MAX_SEGMENT_CHARS) {
      segments.push(current);
      current = [];
      currentChars = 0;
    }
  }
  if (current.length) segments.push(current);

  return segments.map((turnGroup) => ({
    startUserMessageId: turnGroup[0].userMessageId,
    endUserMessageId: turnGroup.at(-1).userMessageId,
    messages: turnGroup
      .flatMap((turn) => turn.messages)
      .sort((left, right) => left.index - right.index)
      .map(({ role, text }) => ({ role, text })),
  }));
}

async function fetchJson(url, init = {}, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      let body = text;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {}
      }
      return { response, body };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(JOB_POLL_MS);
    }
  }
  throw lastError;
}

let reflectionConfig;
let serviceHeaders;

function validatedJob(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger(value.id) ||
    typeof value.segment_id !== "string" ||
    !Number.isInteger(value.projection_version) ||
    !["pending", "running", "succeeded", "failed"].includes(value.status) ||
    !Number.isInteger(value.attempts) ||
    (value.error !== null && typeof value.error !== "string")
  ) {
    throw new Error(
      `invalid Reflection job response: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

async function serviceRequest(path, init = {}, attempts = 5) {
  let lastFailure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    try {
      result = await fetchJson(
        `${reflectionConfig.url}${path}`,
        {
          ...init,
          headers: { ...serviceHeaders, ...init.headers },
        },
        1,
      );
    } catch (error) {
      lastFailure = error;
      if (attempt < attempts) await sleep(JOB_POLL_MS * 2 ** (attempt - 1));
      continue;
    }
    const { response, body } = result;
    if (response.ok) return body;
    lastFailure = new Error(
      `Reflection ${path} returned ${response.status}: ${JSON.stringify(body)}`,
    );
    if (response.status !== 429 && response.status < 500) throw lastFailure;
    if (attempt < attempts) await sleep(JOB_POLL_MS * 2 ** (attempt - 1));
  }
  throw lastFailure;
}

async function getJob(jobId) {
  return validatedJob(await serviceRequest(`/v1/jobs/${jobId}`));
}

async function retryJob(jobId) {
  try {
    const { response, body } = await fetchJson(
      `${reflectionConfig.url}/v1/jobs/${jobId}/retry`,
      { method: "POST", headers: serviceHeaders },
      1,
    );
    if (response.ok) return validatedJob(body);
    if (response.status !== 409) {
      throw new Error(
        `Reflection retry returned ${response.status}: ${JSON.stringify(body)}`,
      );
    }
  } catch (error) {
    log("job retry response was ambiguous", { jobId, error: errorText(error) });
  }
  const current = await getJob(jobId);
  if (["pending", "running", "succeeded"].includes(current.status))
    return current;
  throw new Error(`job ${jobId} remained failed after retry request`);
}

async function waitForJob(job) {
  let current = validatedJob(job);
  while (current.status === "pending" || current.status === "running") {
    await sleep(JOB_POLL_MS);
    current = await getJob(current.id);
  }
  return current;
}

function isProviderBalanceFailure(job) {
  return (
    job.status === "failed" &&
    String(job.error).includes("402 Payment Required")
  );
}

async function completeJob(job) {
  let current = validatedJob(job);
  let nonProviderRounds = 0;
  let providerFailures = 0;
  while (true) {
    if (current.status === "succeeded") return current;
    if (current.status === "failed") {
      if (isProviderBalanceFailure(current)) {
        if (providerFailures > 0) {
          state.status = "waiting_for_provider";
          state.providerStatus = {
            jobId: current.id,
            error: current.error,
            nextRetryAt: new Date(Date.now() + PROVIDER_POLL_MS).toISOString(),
          };
          saveState();
          log("model provider remains unavailable", {
            jobId: current.id,
            nextRetryAt: state.providerStatus.nextRetryAt,
          });
          await sleep(PROVIDER_POLL_MS);
          state.status = "running";
          saveState();
        }
        providerFailures += 1;
      } else {
        nonProviderRounds += 1;
        if (nonProviderRounds >= MAX_NON_PROVIDER_JOB_ROUNDS) return current;
      }
      current = await retryJob(current.id);
    }
    current = await waitForJob(current);
  }
}

function recordFailure(sessionId, segment, job) {
  state.segmentsFailed += 1;
  state.failures.push({
    sessionId,
    startUserMessageId: segment?.startUserMessageId ?? null,
    endUserMessageId: segment?.endUserMessageId ?? null,
    jobId: job?.id ?? null,
    error: String(job?.error ?? "unknown failure").slice(0, 1000),
  });
  state.failures = state.failures.slice(-100);
  saveState();
}

async function processPriorityJobs() {
  for (const jobId of PRIORITY_JOB_IDS) {
    const job = await getJob(jobId);
    if (job.status === "succeeded") continue;
    log("processing retained priority job", { jobId, status: job.status });
    const completed = await completeJob(job);
    if (completed.status !== "succeeded") {
      recordFailure(null, null, completed);
    }
  }
}

const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
const sessions = sqlite
  .prepare(
    "SELECT id, title, time_updated AS timeUpdated FROM session ORDER BY time_created DESC, id DESC",
  )
  .all();
const sessionStatusQuery = sqlite.prepare(
  "SELECT time_updated AS timeUpdated FROM session WHERE id = ?",
);
const messageQuery = sqlite.prepare(`
  SELECT
    m.id,
    json_extract(m.data, '$.role') AS role,
    json_extract(m.data, '$.parentID') AS parentId,
    json_extract(m.data, '$.error') AS error,
    json_extract(m.data, '$.finish') AS finish,
    json_extract(m.data, '$.time.completed') AS timeCompleted,
    COALESCE((
      SELECT group_concat(text, '')
      FROM (
        SELECT CASE
          WHEN json_extract(p.data, '$.type') = 'text'
            THEN COALESCE(json_extract(p.data, '$.text'), '')
          WHEN json_extract(p.data, '$.type') = 'file'
            THEN '[Attachment' ||
                 CASE
                   WHEN json_extract(p.data, '$.filename') IS NOT NULL
                     THEN ' ' || substr(json_extract(p.data, '$.filename'), 1, 500)
                   ELSE ''
                 END ||
                 CASE
                   WHEN json_extract(p.data, '$.mime') IS NOT NULL
                     THEN ' (' || substr(json_extract(p.data, '$.mime'), 1, 200) || ')'
                   ELSE ''
                 END || ']'
          ELSE ''
        END AS text
        FROM part p
        WHERE p.message_id = m.id
          AND COALESCE(json_extract(p.data, '$.ignored'), 0) != 1
        ORDER BY p.id
      )
    ), '') AS text
  FROM message m
  WHERE m.session_id = ?
  ORDER BY m.time_created, m.id
`);

state.sessionsTotal = sessions.length;
saveState();

if (DRY_RUN) {
  let segmentCount = 0;
  let messageCount = 0;
  for (const session of sessions) {
    const segments = segmentMessages(messageQuery.all(session.id));
    segmentCount += segments.length;
    messageCount += segments.reduce(
      (total, segment) => total + segment.messages.length,
      0,
    );
  }
  console.log(
    JSON.stringify({
      sessions: sessions.length,
      segments: segmentCount,
      messages: messageCount,
    }),
  );
  process.exit(0);
}

reflectionConfig = loadJson(REFLECTION_CONFIG_PATH);
serviceHeaders = { "X-Api-Key": reflectionConfig.apiKey };

function stableSessionSnapshot(session) {
  const before = sessionStatusQuery.get(session.id);
  if (!before) return { ready: true, segments: [] };
  const beforeUpdatedAt = Number(before.timeUpdated);
  if (beforeUpdatedAt + INACTIVE_MS > Date.now()) {
    return { ready: false, retryAt: beforeUpdatedAt + INACTIVE_MS };
  }
  const rows = messageQuery.all(session.id);
  const after = sessionStatusQuery.get(session.id);
  if (!after) return { ready: true, segments: [] };
  const afterUpdatedAt = Number(after.timeUpdated);
  if (
    afterUpdatedAt !== beforeUpdatedAt ||
    afterUpdatedAt + INACTIVE_MS > Date.now()
  ) {
    return { ready: false, retryAt: afterUpdatedAt + INACTIVE_MS };
  }
  return { ready: true, segments: segmentMessages(rows) };
}

async function processSession(session, segments) {
  state.status = "running";
  state.currentSessionId = session.id;
  state.currentSessionTitle = session.title;
  for (const [segmentIndex, segment] of segments.entries()) {
    state.segmentsDiscovered += 1;
    state.currentSegment = {
      index: segmentIndex,
      count: segments.length,
      startUserMessageId: segment.startUserMessageId,
      endUserMessageId: segment.endUserMessageId,
    };
    saveState();
    const submission = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        start_user_message_id: segment.startUserMessageId,
        end_user_message_id: segment.endUserMessageId,
        projection_version: PROJECTION_VERSION,
        messages: segment.messages,
      }),
    };
    let job = validatedJob(
      await serviceRequest("/v1/segments", submission),
    );
    let wasAlreadySucceeded = job.status === "succeeded";
    let completed = await completeJob(job);
    while (
      completed.status === "succeeded" &&
      completed.projection_version < PROJECTION_VERSION
    ) {
      job = validatedJob(
        await serviceRequest("/v1/segments", submission),
      );
      wasAlreadySucceeded = wasAlreadySucceeded && job.status === "succeeded";
      completed = await completeJob(job);
    }
    if (completed.status === "succeeded") {
      if (wasAlreadySucceeded) state.segmentsAlreadySucceeded += 1;
      else state.segmentsSucceeded += 1;
    } else {
      recordFailure(session.id, segment, completed);
    }
    saveState();
  }
  state.sessionsVisited += 1;
  saveState();
}

async function backfill() {
  acquireLock();
  saveState();
  try {
    state.status = "running";
    saveState();
    await processPriorityJobs();
    let queue = sessions;
    while (queue.length) {
      const deferred = [];
      for (const session of queue) {
        const snapshot = stableSessionSnapshot(session);
        if (!snapshot.ready) {
          deferred.push({ session, retryAt: snapshot.retryAt });
          continue;
        }
        await processSession(session, snapshot.segments);
      }
      if (!deferred.length) break;
      const earliestRetryAt = Math.min(
        ...deferred.map(({ retryAt }) => retryAt),
      );
      const waitMs = Math.max(
        JOB_POLL_MS,
        Math.min(60_000, earliestRetryAt - Date.now()),
      );
      state.status = "waiting_for_session_inactivity";
      state.currentSessionId = null;
      state.currentSessionTitle = null;
      state.currentSegment = null;
      state.deferredSessions = deferred.length;
      saveState();
      log("deferred active sessions", {
        count: deferred.length,
        nextCheckAt: new Date(Date.now() + waitMs).toISOString(),
      });
      await sleep(waitMs);
      queue = deferred.map(({ session }) => session);
    }
    state.status = state.segmentsFailed
      ? "completed_with_failures"
      : "completed";
    state.completedAt = now();
    state.currentSessionId = null;
    state.currentSessionTitle = null;
    state.currentSegment = null;
    saveState();
    log("backfill completed", {
      sessionsVisited: state.sessionsVisited,
      segmentsSucceeded: state.segmentsSucceeded,
      segmentsAlreadySucceeded: state.segmentsAlreadySucceeded,
      segmentsFailed: state.segmentsFailed,
    });
    scheduleLaunchAgentCleanup();
  } finally {
    releaseLock();
  }
}

backfill().catch((error) => {
  state.status = "failed";
  state.fatalError = errorText(error);
  saveState();
  log("backfill worker failed", { error: errorText(error) });
  releaseLock();
  process.exitCode = 1;
});
