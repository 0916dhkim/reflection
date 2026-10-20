export const warn = (message: string) =>
  console.warn(`[reflection-v2] ${message}`);

const token = (value: string) =>
  /^[A-Za-z0-9_.:/@+-]+$/.test(value) ? value : JSON.stringify(value);

export function errorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    if (typeof current !== "object") return;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
}

export function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RequestFailure {
  operation: string;
  target: "backend" | "source";
  method: "GET" | "POST";
  url: string;
  status?: number;
  elapsedMs: number;
  timeoutMs: number;
  error?: unknown;
}

export function formatRequestFailure(input: RequestFailure): string {
  const fields = [
    "request-failed",
    `op=${token(input.operation)}`,
    `target=${input.target}`,
    `method=${input.method}`,
    `url=${JSON.stringify(input.url)}`,
    `status=${input.status ?? "none"}`,
    `elapsed_ms=${input.elapsedMs.toFixed(1)}`,
    `timeout_ms=${input.timeoutMs}`,
  ];
  if (input.error !== undefined) {
    fields.push(
      `error=${token(errorName(input.error))}`,
      `error_message=${JSON.stringify(errorMessage(input.error))}`,
    );
    const code = errorCode(input.error);
    if (code !== undefined) fields.push(`cause=${token(code)}`);
  }
  return fields.join(" ");
}

export interface AnchorMissing {
  session: string;
  reason: string;
  previousAnchor: boolean;
  latest?: string;
  latestUsage?: number;
}

export function formatAnchorMissing(input: AnchorMissing): string {
  return [
    "usage-anchor-missing",
    `session=${token(input.session)}`,
    `reason=${token(input.reason)}`,
    `previous_anchor=${input.previousAnchor ? "present" : "absent"}`,
    `latest=${input.latest === undefined ? "none" : token(input.latest)}`,
    `latest_usage=${input.latestUsage ?? "none"}`,
  ].join(" ");
}

export interface ProjectionDecision {
  session: string;
  lossy: boolean;
  estimatedTokens: number;
  trackedTokens?: number;
  soft: number;
  hard: number;
  omitted: number;
  checkpoint: boolean;
  usageAnchor: boolean;
  reused?: boolean;
  context: number;
  output: number;
}

export function formatProjectionDecision(input: ProjectionDecision): string {
  return [
    "projection",
    `session=${token(input.session)}`,
    `plan=${input.lossy ? "lossy" : "projected"}`,
    `estimated_tokens=${input.estimatedTokens}`,
    `estimate_source=${input.trackedTokens === undefined ? "conservative" : "provider-anchor"}`,
    `tracked_tokens=${input.trackedTokens ?? "none"}`,
    `soft=${input.soft}`,
    `hard=${input.hard}`,
    `omitted=${input.omitted}`,
    `checkpoint=${input.checkpoint ? "yes" : "no"}`,
    `usage_anchor=${input.usageAnchor ? "present" : "missing"}`,
    `reused=${input.reused ? "yes" : "no"}`,
    `context=${input.context}`,
    `output=${input.output}`,
  ].join(" ");
}
