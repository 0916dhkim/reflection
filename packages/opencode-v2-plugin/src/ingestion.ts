import {
  parseNativeJobResponse,
  parseNativeSessionSegmentsResponse,
  type NativeSessionSegmentsResponse,
  type NativeJobResponse,
} from "@reflection/shared/native";
import {
  planNativeSegments,
  type NativePlannedSegment,
} from "@reflection/opencode-v2-core/segmentation";
import { Operations, bounded } from "./operations.js";
import {
  Transport,
  AvailabilityError,
  RequestRejectedError,
  object,
  page,
} from "./transport.js";

export const warn = (message: string) =>
  console.warn(`[reflection-v2] ${message}`);
export class Ingestion {
  private readonly submitted = new Map<
    string,
    { hash: string; priority: number }
  >();
  private readonly retried = new Set<string>();
  private readonly retrying = new Set<string>();
  private readonly pendingRetries = new Map<
    string,
    { original: NativeJobResponse; httpFailure: boolean }
  >();
  private readonly idle = new Map<
    string,
    { dirty: boolean; task: Promise<void> }
  >();
  private readonly revisions = new Map<
    string,
    { revision: string; checked: number }
  >();
  private sweepCursor: string | undefined;
  private sweeping: Promise<void> | undefined;
  private sweepDirty = false;
  constructor(
    readonly http: Transport,
    readonly operations: Operations,
    readonly directory: string,
  ) {}
  async manifest(id: string, signal: AbortSignal) {
    const manifest = parseNativeSessionSegmentsResponse(
      (
        await this.http.request(
          `/v1/sessions/${encodeURIComponent(id)}/segments?source_id=${encodeURIComponent(this.http.config.sourceId)}`,
          signal,
        )
      ).value,
      this.http.config.sourceId,
    );
    if (manifest.session_id !== id)
      throw new Error("Reflection: manifest session mismatch");
    return manifest;
  }
  async submit(
    segments: readonly NativePlannedSegment[],
    manifest: NativeSessionSegmentsResponse,
    signal: AbortSignal,
    requestedPriority: 0 | 50 | 100,
  ) {
    manifest = parseNativeSessionSegmentsResponse(
      manifest,
      this.http.config.sourceId,
    );
    for (const segment of segments) {
      signal.throwIfAborted();
      if (
        manifest.session_id !== segment.request.session_id ||
        segment.request.source_id !== this.http.config.sourceId
      )
        throw new Error("Reflection: submission source/session mismatch");
      const key = JSON.stringify([segment.request.session_id, segment.id]);
      const retryKey = JSON.stringify([
        segment.request.session_id,
        segment.id,
        segment.fingerprint,
      ]);
      const sent = this.submitted.get(key);
      const priority = segment.closed ? requestedPriority : 0;
      const targets = manifest.targets.filter(
        (target) => target.id === segment.id,
      );
      const boundaries = manifest.boundaries.filter(
        (boundary) => boundary.id === segment.id,
      );
      const exact = (
        entry: (typeof targets)[number] | (typeof boundaries)[number],
      ) =>
        entry.source_boundary_version === 3 &&
        entry.source_fingerprint === segment.fingerprint &&
        entry.projection_version === 3 &&
        entry.start_source_message_id ===
          segment.request.start_source_message_id &&
        entry.end_source_message_id === segment.request.end_source_message_id;
      // A replacement target owns the current range; the previous committed
      // boundary can remain stale/ineligible until extraction finishes.
      const confirmed =
        targets.length > 0
          ? targets.every(
              (target) =>
                exact(target) &&
                ["pending", "running", "succeeded"].includes(target.status),
            )
          : boundaries.length > 0 &&
            boundaries.every(
              (boundary) => exact(boundary) && boundary.source_eligible,
            );
      if (
        sent?.hash === segment.fingerprint &&
        sent.priority >= priority &&
        confirmed &&
        !this.pendingRetries.has(retryKey)
      )
        continue;
      if (!confirmed) this.submitted.delete(key);
      // Manifest targets do not expose priority. Submit once locally even for a
      // matching pending target so a closed range can promote an open snapshot.
      let job = parseNativeJobResponse(
        (
          await this.http.request("/v1/segments", signal, undefined, {
            ...segment.request,
            processing_priority: priority,
          })
        ).value,
        this.http.config.sourceId,
      );
      const matches = () =>
        job.segment_id === segment.id &&
        job.source_fingerprint === segment.fingerprint &&
        job.projection_version === 3 &&
        job.start_source_message_id ===
          segment.request.start_source_message_id &&
        job.end_source_message_id === segment.request.end_source_message_id;
      if (!matches())
        throw new Error("Reflection: owned job ID/hash/boundary mismatch");
      if (job.status === "failed" || this.pendingRetries.has(retryKey))
        job = await this.retryJob(job, retryKey, signal);
      if (job.status === "superseded")
        throw new Error("Reflection: target superseded during submission");
      this.submitted.set(key, {
        hash: segment.fingerprint,
        priority:
          confirmed && sent?.hash === segment.fingerprint
            ? Math.max(priority, sent.priority)
            : priority,
      });
    }
  }
  private async retryJob(
    job: NativeJobResponse,
    key: string,
    signal: AbortSignal,
  ): Promise<NativeJobResponse> {
    if (this.retrying.has(key)) throw new AvailabilityError();
    this.retrying.add(key);
    const validate = (value: unknown, original: NativeJobResponse) => {
      const current = parseNativeJobResponse(value, this.http.config.sourceId);
      if (
        current.id !== original.id ||
        current.segment_id !== original.segment_id ||
        current.source_fingerprint !== original.source_fingerprint ||
        current.projection_version !== original.projection_version ||
        current.start_source_message_id !== original.start_source_message_id ||
        current.end_source_message_id !== original.end_source_message_id
      )
        throw new Error(
          "Reflection: reconciled/retried job ID/hash/boundary mismatch",
        );
      return current;
    };
    const signature = (value: NativeJobResponse) =>
      JSON.stringify([
        value.status,
        value.attempts,
        value.started_at,
        value.finished_at,
      ]);
    const observe = (
      current: NativeJobResponse,
      pending: { original: NativeJobResponse; httpFailure: boolean },
    ) => {
      if (
        ["pending", "running", "succeeded"].includes(current.status) ||
        (current.status === "failed" &&
          signature(current) !== signature(pending.original))
      ) {
        this.retried.add(key);
        this.pendingRetries.delete(key);
        return current;
      }
      if (current.status === "failed" && pending.httpFailure) {
        this.pendingRetries.delete(key);
        return current;
      }
      // An unchanged terminal read after a timeout does not prove the POST is
      // no longer in flight. Keep reconciling on later triggers, never repost.
      throw new AvailabilityError();
    };
    const reconcile = async (pending: {
      original: NativeJobResponse;
      httpFailure: boolean;
    }) => {
      const response = await this.http
        .request(
          `/v1/jobs/${pending.original.id}?source_id=${encodeURIComponent(this.http.config.sourceId)}`,
          signal,
        )
        .catch((error) => {
          if (error instanceof RequestRejectedError)
            throw new AvailabilityError(error.status);
          throw error;
        });
      return observe(validate(response.value, pending.original), pending);
    };
    try {
      const pending = this.pendingRetries.get(key);
      if (pending) job = await reconcile(pending);
      if (job.status !== "failed") return job;
      if (this.retried.has(key))
        throw new Error(
          "Reflection: exact target remained failed after one retry",
        );
      const attempt = { original: job, httpFailure: false };
      this.pendingRetries.set(key, attempt);
      let value: unknown;
      try {
        value = (
          await this.http.request(
            `/v1/jobs/${job.id}/retry`,
            signal,
            undefined,
            { source_id: this.http.config.sourceId },
          )
        ).value;
      } catch (error) {
        attempt.httpFailure =
          error instanceof RequestRejectedError ||
          (error instanceof AvailabilityError && error.status !== undefined);
        signal.throwIfAborted();
        job = await reconcile(attempt);
        if (!this.retried.has(key)) throw error;
        if (job.status === "failed")
          throw new Error(
            "Reflection: exact target remained failed after one retry",
          );
        return job;
      }
      job = validate(value, attempt.original);
      // A valid response still needs observable evidence of a business retry.
      // This is best-effort at-most-one confirmed retry, not exactly-once delivery.
      if (
        job.status === "failed" &&
        signature(job) === signature(attempt.original)
      )
        job = await reconcile(attempt);
      else job = observe(job, attempt);
      if (job.status === "failed")
        throw new Error(
          "Reflection: exact target remained failed after one retry",
        );
      return job;
    } finally {
      this.retrying.delete(key);
    }
  }
  schedule(id: string): Promise<void> {
    const current = this.idle.get(id);
    if (current) {
      current.dirty = true;
      return current.task;
    }
    const state = { dirty: false, task: Promise.resolve() };
    state.task = this.operations
      .queue(id, async () => {
        do {
          state.dirty = false;
          await this.operations
            .run(id, (signal) => this.update(id, false, signal), 60000, true)
            .then((success) => {
              if (success) void this.sweep();
            })
            .catch(() =>
              warn(
                "Idle ingestion deferred: source snapshot/target unavailable",
              ),
            );
        } while (
          state.dirty &&
          !this.operations.stopped &&
          !this.operations.deleted.has(id)
        );
      })
      .catch(() => {})
      .finally(() => this.idle.delete(id));
    this.idle.set(id, state);
    return state.task;
  }
  async update(id: string, open: boolean, signal: AbortSignal) {
    const source = await this.http.source(this.http.config.sourceId, signal);
    const reader = this.http.reader(source);
    const metadata = await this.http.session(reader, id, signal);
    if (object(metadata.location).directory !== this.directory) return;
    const snapshot = await this.http.snapshot(source, id, signal, true, true);
    if (object(snapshot.info.location).directory !== this.directory) return;
    if (open) {
      const time = object(snapshot.info.time);
      const updated = Number(time.updated);
      // Native updated marks admission; idle marks completion of a long run.
      const idle =
        typeof time.idle === "number" && Number.isFinite(time.idle)
          ? time.idle
          : updated;
      if (Date.now() - Math.max(updated, idle) < 600000) return;
    }
    const manifest = await this.manifest(id, signal);
    const segments = planNativeSegments({
      source,
      sessionId: id,
      records: snapshot.records,
      manifest,
      allowOpenSnapshot: open,
    });
    // Recheck after manifest planning, immediately before writing owned targets.
    if (
      JSON.stringify(snapshot.info) !==
        JSON.stringify(await this.http.session(reader, id, signal)) ||
      (await this.http.active(reader, id, signal)) !== "inactive"
    )
      throw new Error("Reflection: idle snapshot became stale");
    await this.submit(segments, manifest, signal, open ? 0 : 50);
    this.revisions.set(id, {
      revision: JSON.stringify(snapshot.info),
      checked: Date.now(),
    });
    return true;
  }
  sweep(): Promise<void> {
    if (this.sweeping) {
      this.sweepDirty = true;
      return this.sweeping;
    }
    this.sweepDirty = false;
    this.sweeping = this.operations
      .run(
        undefined,
        async (signal) => {
          const source = await this.http.source(
            this.http.config.sourceId,
            signal,
          );
          const query = new URLSearchParams({ limit: "20" });
          if (this.sweepCursor) query.set("cursor", this.sweepCursor);
          else query.set("order", "asc");
          const batch = page(
            (
              await this.http.request(
                `/api/session?${query}`,
                signal,
                this.http.reader(source),
              )
            ).value,
          );
          this.sweepCursor = batch.next;
          for (const raw of batch.data.slice(0, 20)) {
            signal.throwIfAborted();
            const info = object(raw);
            const id = info.id;
            if (
              typeof id !== "string" ||
              this.operations.deleted.has(id) ||
              object(info.location).directory !== this.directory
            )
              continue;
            const cached = this.revisions.get(id);
            if (
              cached?.revision === JSON.stringify(info) &&
              Date.now() - cached.checked < 600000
            )
              continue;
            await bounded(
              this.operations.queue(id, () => {
                signal.throwIfAborted();
                return this.operations.run(
                  id,
                  (local) =>
                    this.update(id, true, AbortSignal.any([signal, local])),
                  60000,
                  true,
                );
              }),
              signal,
            ).catch(() => warn("Inactive sweep candidate deferred"));
          }
          for (const [id, cached] of this.revisions)
            if (Date.now() - cached.checked > 600000) this.revisions.delete(id);
        },
        60000,
        true,
      )
      .catch(() => warn("Inactive sweep interrupted or unavailable"))
      .finally(() => {
        this.sweeping = undefined;
        if (this.sweepDirty && !this.operations.stopped) void this.sweep();
      });
    return this.sweeping;
  }
  clear(id: string) {
    this.revisions.delete(id);
    for (const key of this.submitted.keys())
      if ((JSON.parse(key) as string[])[0] === id) this.submitted.delete(key);
    for (const key of this.retried)
      if ((JSON.parse(key) as string[])[0] === id) this.retried.delete(key);
    for (const key of this.pendingRetries.keys())
      if ((JSON.parse(key) as string[])[0] === id)
        this.pendingRetries.delete(key);
  }
}
