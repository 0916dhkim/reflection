import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { z } from "zod";
import {
  NativeProjectionError,
  projectNativeContext,
  type NativeProjectionResult,
} from "@reflection/opencode-v2-core/projection";
import {
  hydrateNativeRange,
  planNativeSegments,
} from "@reflection/opencode-v2-core/segmentation";
import { parseIngestSegmentResponse } from "@reflection/shared/ingestion";
import {
  nativeSegmentIdForRequest,
  type NativeSessionSegmentsResponse,
} from "@reflection/shared/native";
import { readSegmentMessages } from "@reflection/shared/segmentation";
import {
  Transport,
  AvailabilityError,
  RegistryUnavailableError,
  automaticCompaction,
  configSchema,
  legacyHistory,
  object,
} from "./transport.js";
import { Ingestion, warn } from "./ingestion.js";
import { Operations, bounded } from "./operations.js";
import {
  WRAPPER_RESERVE,
  checkpoint,
  checkpointSchemaJson,
  estimateMessages,
  estimationValue,
  materialize,
  materializedTokens,
} from "./projection.js";

export default Plugin.define({ id: "reflection-v2", setup });

export async function setup(ctx: Plugin.Context) {
  const operations = new Operations();
  const subscriptions = new AbortController();
  let http: Transport | undefined;
  let ingestion: Ingestion | undefined;
  let startupError =
    "Reflection: initializing mandatory projection; retry when source registry is ready";
  let ready = false;
  let registryRetryAllowed = false;
  let registryAttempt: Promise<void> | undefined;
  let eventTask: Promise<void> = Promise.resolve();
  const key = (id: string) =>
    `reflection-v2/checkpoint/2/${encodeURIComponent(http!.config.sourceId)}/${encodeURIComponent(id)}`;
  const requireReady = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!ready && registryRetryAllowed && !operations.stopped)
      await bounded(initializeRegistry(), signal);
    signal.throwIfAborted();
    if (!ready || !http || !ingestion || operations.stopped)
      throw new Error(startupError);
    return { http, ingestion };
  };
  // Install both guards before reading config or initiating registry/network IO.
  // Returning normally with guards retained is essential: a setup exception can
  // cause the host to unload the plugin and silently restore native behavior.
  const compaction = await ctx.session.hook("compaction", () => {
    throw new Error("Reflection owns compaction; native checkpoint forbidden");
  });
  const context = await ctx.session.hook("context", (event) =>
    operations.queue(event.sessionID, () =>
      operations.run(event.sessionID, (signal) => project(event, signal)),
    ),
  );
  const dispatch = await ctx.session.hook("model.request", (event) =>
    operations.run(event.sessionID, async (signal) => {
      const { http } = await requireReady(signal);
      if (event.kind === "compaction")
        throw new Error(
          "Reflection owns compaction; native checkpoint forbidden",
        );
      const source = await http.source(http.config.sourceId, signal);
      const info = await http.session(
        http.reader(source),
        event.sessionID,
        signal,
      );
      const directory = String(object(info.location).directory);
      if (directory !== ctx.location.directory)
        throw new Error(
          "Reflection: session location is not owned by this plugin instance",
        );
      const query = new URLSearchParams({
        "location[directory]": directory,
      });
      if (
        automaticCompaction(
          (
            await http.request(
              `/api/config?${query}`,
              signal,
              http.reader(source),
            )
          ).value,
        )
      )
        throw new Error(
          "Reflection: effective compaction.auto must be false before model dispatch",
        );
    }),
  );
  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: "memory_search",
      options: { codemode: false },
      description:
        "Search Reflection memory for claims and source_id + segment_id citations.",
      input: z.object({ query: z.string().trim().min(1) }).strict(),
      async execute({ query }, tool) {
        return toolResult(tool.sessionID, async (signal) => {
          const { http } = await requireReady(signal);
          return (
            await http.request("/v1/search", signal, undefined, { query })
          ).value;
        });
      },
    });
    editor.add({
      name: "memory_read_segment",
      options: { codemode: false },
      description:
        "Read exact ordered history using both the Reflection source_id and segment_id. Never substitute another source.",
      input: z
        .object({
          source_id: z.string().trim().min(1).max(500),
          segment_id: z.string().uuid(),
        })
        .strict(),
      async execute({ source_id, segment_id }, tool) {
        return toolResult(tool.sessionID, async (signal) => {
          const { http } = await requireReady(signal);
          const source = await http.source(source_id, signal);
          let segment;
          try {
            segment = parseIngestSegmentResponse(
              (
                await http.request(
                  `/v1/segments/${encodeURIComponent(segment_id)}?source_id=${encodeURIComponent(source_id)}`,
                  signal,
                )
              ).value,
              source_id,
            );
          } catch {
            throw new Error(
              "Reflection: segment unavailable or invalid source-owned metadata",
            );
          }
          if (segment.id !== segment_id)
            throw new Error("Reflection: segment ID mismatch");
          if (segment.source_boundary_version === 3) {
            if (source.kind !== "opencode-v2")
              throw new Error(
                "Reflection: native boundary requires an opencode-v2 source",
              );
            const snapshot = await http.snapshot(
              source,
              segment.session_id,
              signal,
              false,
            );
            const messages = hydrateNativeRange(snapshot.records, segment);
            const request = {
              source_id,
              session_id: segment.session_id,
              source_boundary_version: 3 as const,
              projection_version: 3 as const,
              processing_priority: 0,
              start_source_message_id: segment.start_source_message_id,
              end_source_message_id: segment.end_source_message_id,
              messages,
            };
            if (nativeSegmentIdForRequest(request, source) !== segment.id)
              throw new Error("Reflection: native segment identity mismatch");
            // SegmentResponse does not publish a source fingerprint. Do not
            // fabricate hash verification; report the exact checks performed.
            return {
              source_id,
              segment_id,
              messages,
              verification:
                "source registry, deterministic segment ID, stable ordered history, complete exact endpoints; backend fingerprint unavailable",
            };
          }
          if (source.kind !== "opencode-v1")
            throw new Error(
              "Reflection: legacy boundary requires an opencode-v1 source",
            );
          const messages = readSegmentMessages(
            legacyHistory(
              await http.history(source, segment.session_id, signal),
            ),
            segment.source_boundary_version === 1
              ? {
                  id: segment.id,
                  sourceBoundaryVersion: 1,
                  startSourceMessageId: null,
                  endSourceMessageId: null,
                  startUserMessageId: segment.start_user_message_id,
                  endUserMessageId: segment.end_user_message_id,
                }
              : {
                  id: segment.id,
                  sourceBoundaryVersion: 2,
                  startSourceMessageId: segment.start_source_message_id,
                  endSourceMessageId: segment.end_source_message_id,
                  startUserMessageId: segment.start_user_message_id,
                  endUserMessageId: segment.end_user_message_id,
                },
          );
          return { source_id, segment_id, messages };
        });
      },
    });
  });

  async function toolResult(
    id: string,
    work: (signal: AbortSignal) => Promise<unknown>,
  ) {
    try {
      return { content: JSON.stringify(await operations.run(id, work)) };
    } catch (error) {
      return { content: JSON.stringify({ error: safeError(error) }) };
    }
  }
  async function project(event: SessionContext, signal: AbortSignal) {
    try {
      const { http, ingestion } = await requireReady(signal);
      const source = await http.source(http.config.sourceId, signal);
      const snapshot = await http.snapshot(
        source,
        event.sessionID,
        signal,
        false,
      );
      const directory = String(object(snapshot.info.location).directory);
      if (directory !== ctx.location.directory)
        throw new Error(
          "Reflection: session location is not owned by this plugin instance",
        );
      if (
        snapshot.records.some(
          (record) =>
            record.raw.type === "compaction" &&
            record.raw.status === "completed",
        )
      )
        throw new Error(
          "Reflection: preexisting native compaction requires an uncompacted session; native fallback forbidden",
        );
      const query = new URLSearchParams({
        "location[directory]": directory,
      });
      if (
        automaticCompaction(
          (
            await http.request(
              `/api/config?${query}`,
              signal,
              http.reader(source),
            )
          ).value,
        )
      )
        throw new Error(
          "Reflection: effective compaction.auto must be false before model dispatch",
        );
      const models = await bounded(
        ctx.model.list({ location: ctx.location }),
        signal,
      );
      const model = models.data.find(
        (model) =>
          model.id === event.model.id &&
          model.providerID === event.model.providerID,
      );
      if (!model)
        throw new Error("Reflection: current model limits unavailable");
      const output =
        typeof event.options.maxTokens === "number" &&
        Number.isFinite(event.options.maxTokens)
          ? event.options.maxTokens
          : model.limit.output;
      const stored = await bounded(
        ctx.storage.get(key(event.sessionID)),
        signal,
      );
      let previous = checkpoint(stored, source.id, event.sessionID);
      if (stored !== undefined && !previous)
        warn("Invalid checkpoint discarded; rebuilding Reflection projection");
      let manifest: NativeSessionSegmentsResponse;
      let manifestAvailable = true;
      try {
        manifest = await ingestion.manifest(event.sessionID, signal);
      } catch (error) {
        if (!(error instanceof AvailabilityError)) throw error;
        signal.throwIfAborted();
        manifestAvailable = false;
        manifest = {
          source_id: source.id,
          session_id: event.sessionID,
          manifest_version: 2,
          segments: [],
          boundaries: [],
          targets: [],
        };
        warn(
          "Manifest temporarily unavailable; projecting verified native history with explicit missing-summary markers when needed",
        );
      }
      const segmentInput = {
        source,
        sessionId: event.sessionID,
        records: snapshot.records,
        manifest,
      };
      let segments: ReturnType<typeof planNativeSegments>;
      if (!manifestAvailable && previous) {
        try {
          // Local hints preserve frozen packing, not backend eligibility. Require
          // the exact ordered complete prefix; the core separately proves hashes
          // before reusing cached summary text, including after source changes.
          let cursor = 0;
          for (const range of previous.archived) {
            for (const id of range.source_message_ids) {
              const record = snapshot.records[cursor++];
              if (!record?.complete || record.source.id !== id)
                throw new Error("invalid local planning hint");
            }
          }
          const planningManifest: NativeSessionSegmentsResponse = {
            ...manifest,
            boundaries: previous.archived.map((range) => ({
              id: range.id,
              source_boundary_version: 3,
              start_source_message_id: range.start_source_message_id,
              end_source_message_id: range.end_source_message_id,
              projection_version: 3,
              source_fingerprint: range.source_fingerprint,
              source_eligible: false,
            })),
          };
          segments = planNativeSegments({
            ...segmentInput,
            manifest: planningManifest,
          });
        } catch {
          previous = undefined;
          warn(
            "Invalid checkpoint planning hints discarded; rebuilding from native history",
          );
          segments = planNativeSegments(segmentInput);
        }
      } else segments = planNativeSegments(segmentInput);
      const system = estimationValue(event.system);
      const toolBudget = estimationValue(event.tools);
      const input = {
        source,
        sessionId: event.sessionID,
        records: snapshot.records,
        segments,
        messages: estimateMessages(event.messages),
        system: [system, WRAPPER_RESERVE],
        tools: toolBudget,
        contextLimit: model.limit.context,
        inputLimit: model.limit.input,
        outputLimit: output,
        previous,
        allowLossy: true as const,
      };
      let plan: NativeProjectionResult | undefined;
      try {
        plan = projectNativeContext({
          ...input,
          manifest,
          manifestUnavailable: !manifestAvailable,
        });
      } catch (error) {
        if (segments.length === 0) throw error;
      }
      if (
        manifestAvailable &&
        (!plan || plan.reset || (!previous && plan.notice))
      ) {
        // One aggregate five-second synchronization window, never wait for LLM
        // extraction. The core emits explicit omissions for missing summaries.
        const syncSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        try {
          await ingestion.submit(
            segments.filter((segment) => segment.closed),
            manifest,
            syncSignal,
            100,
          );
          try {
            manifest = await ingestion.manifest(event.sessionID, syncSignal);
            manifestAvailable = true;
          } catch (error) {
            if (error instanceof AvailabilityError) manifestAvailable = false;
            throw error;
          }
        } catch (error) {
          if (!(error instanceof AvailabilityError) && !syncSignal.aborted)
            throw error;
          warn(
            "Closed targets not fully synchronized within projection window; exact missing summaries remain explicit omissions",
          );
        }
        signal.throwIfAborted();
        plan = projectNativeContext({
          ...input,
          manifest,
          manifestUnavailable: !manifestAvailable,
        });
      }
      if (!plan)
        plan = projectNativeContext({
          ...input,
          manifest,
          manifestUnavailable: !manifestAvailable,
        });
      const messages = materialize(plan, event.messages);
      const usable = Math.min(
        model.limit.input ?? model.limit.context,
        model.limit.context - output,
      );
      if (
        materializedTokens(messages, system, toolBudget) >
        Math.floor(usable * 0.9)
      )
        throw new Error(
          "Reflection: materialized context exceeds hard input budget",
        );
      signal.throwIfAborted();
      if (plan.checkpoint) {
        // Build structural JSON without unsafe SDK casts or class instances.
        const json = checkpointSchemaJson(plan.checkpoint);
        await bounded(ctx.storage.set(key(event.sessionID), json), signal);
      } else if (stored !== undefined)
        await bounded(ctx.storage.remove(key(event.sessionID)), signal);
      signal.throwIfAborted();
      event.messages = messages;
      if (plan.lossy)
        warn(
          `Projection contains ${plan.omissions.length} explicitly marked omitted ranges`,
        );
      if (plan.deferredReason)
        warn(
          "Projection deferred below hard input budget; raw source-safe context retained",
        );
    } catch (error) {
      const message = safeError(error);
      warn(message);
      throw new Error(message);
    }
  }

  const initialization = operations.run(undefined, async (signal) => {
    try {
      if (ctx.app?.version !== "2.0.8")
        throw new Error(
          "Reflection: unsupported OpenCode host version; exactly 2.0.8 is required; native fallback forbidden",
        );
      const configPath = ctx.options.configPath;
      if (typeof configPath !== "string" || !isAbsolute(configPath))
        throw new Error(
          "Reflection: options.configPath must be an explicit absolute v2-only JSON config path",
        );
      const text = await readFile(configPath, { encoding: "utf8", signal });
      const parsed = configSchema.safeParse(JSON.parse(text) as unknown);
      if (!parsed.success)
        throw new Error(
          "Reflection: invalid config; mandatory contextProjection.enabled=true and valid isolated source endpoints are required",
        );
      http = new Transport(parsed.data);
      registryRetryAllowed = true;
      await initializeRegistry();
    } catch (error) {
      startupError = safeError(error);
      warn(startupError);
    }
  });
  function initializeRegistry(): Promise<void> {
    if (registryAttempt) return registryAttempt;
    const transport = http;
    if (!transport || !registryRetryAllowed || ready || operations.stopped)
      return Promise.resolve();
    registryAttempt = operations
      .run(
        undefined,
        async (signal) => {
          try {
            await transport.source(transport.config.sourceId, signal);
            signal.throwIfAborted();
            if (operations.stopped || subscriptions.signal.aborted) return;
            ingestion = new Ingestion(
              transport,
              operations,
              ctx.location.directory,
            );
            ready = true;
            registryRetryAllowed = false;
            warn(
              "Mandatory Reflection projection active; native compaction veto installed. SDK callback cancellation is not propagated; owned operations are bounded and deletion/idle cancellation is best effort.",
            );
            eventTask = listen().catch(() => {
              if (operations.stopped) return;
              ready = false;
              registryRetryAllowed = false;
              startupError =
                "Reflection: event subscription failed; model dispatch blocked until plugin reload";
              warn(startupError);
            });
          } catch (error) {
            if (operations.stopped || subscriptions.signal.aborted) return;
            registryRetryAllowed =
              error instanceof RegistryUnavailableError || signal.aborted;
            startupError = safeError(error);
            warn(startupError);
          }
        },
        6000,
      )
      .finally(() => {
        registryAttempt = undefined;
      });
    return registryAttempt;
  }
  async function listen() {
    for await (const event of ctx.event.subscribe({
      signal: subscriptions.signal,
    })) {
      if (operations.stopped) break;
      const data = object(event.data);
      const id = data.sessionID;
      if (typeof id !== "string") continue;
      if (event.type === "session.deleted") {
        ingestion?.clear(id);
        void operations
          .delete(id, () =>
            bounded(ctx.storage.remove(key(id)), AbortSignal.timeout(5000)),
          )
          .catch(() => warn("Deleted session checkpoint removal failed"));
      } else if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted" ||
        event.type === "session.idle" ||
        (event.type === "session.status" && object(data.status).type === "idle")
      ) {
        // Native 2.0.8 emits execution terminal events; idle/status are aliases.
        // Terminal aliases must not cancel ingestion started by the first event.
        operations.abort(id, true);
        void ingestion?.schedule(id);
      }
    }
    if (!operations.stopped && !subscriptions.signal.aborted)
      throw new Error("Reflection: event stream ended unexpectedly");
  }
  await initialization;
  return async () => {
    ready = false;
    registryRetryAllowed = false;
    startupError = "Reflection: plugin disposed; native fallback forbidden";
    subscriptions.abort();
    await operations.dispose();
    await initialization;
    await bounded(eventTask, AbortSignal.timeout(5000)).catch(() => {});
    await bounded(
      Promise.all([
        context.dispose(),
        compaction.dispose(),
        dispatch.dispose(),
        tools.dispose(),
      ]),
      AbortSignal.timeout(5000),
    );
  };
}

function safeError(error: unknown): string {
  if (error instanceof NativeProjectionError)
    return `Reflection: ${error.message}; native fallback forbidden`;
  return error instanceof Error && error.message.startsWith("Reflection:")
    ? error.message
    : "Reflection: operation failed validation or is unavailable; no native fallback";
}
