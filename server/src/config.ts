import { loadEnvFile } from "node:process";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface Settings {
  readonly databaseUrl: string;
  readonly reflectionApiKey: string;
  readonly openrouterApiKey: string;
  readonly voyageApiKey: string;
  readonly openrouterBaseUrl: string;
  readonly voyageBaseUrl: string;
  readonly extractionModel: string;
  readonly extractionProvider: string;
  readonly extractionReasoningEffort: ReasoningEffort;
  readonly extractionNativeSchema: boolean;
  readonly resolutionModel: string;
  readonly resolutionProvider: string;
  readonly resolutionReasoningEffort: ReasoningEffort;
  readonly resolutionNativeSchema: boolean;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly databasePoolMinSize: number;
  readonly databasePoolMaxSize: number;
  readonly workerPollSeconds: number;
  readonly workerConcurrency: number;
  readonly workerMaxAttempts: number;
  readonly workerRetryBackoffSeconds: number;
  readonly workerLockId: number | string;
  readonly migrationLockId: number | string;
  readonly requestTimeoutSeconds: number;
  readonly modelCallTimeoutSeconds: number;
  readonly migrationsDir: string;
  readonly logLevel: string;
}

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const MAX_TIMER_SECONDS = 2_147_483_647 / 1000;

function loadLocalEnvFile(): void {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

function required(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { nonempty?: boolean } = {},
): string {
  const value = env[name];
  if (value === undefined) {
    throw new SettingsValidationError(`${name} is required`);
  }
  if (options.nonempty && value.length === 0) {
    throw new SettingsValidationError(`${name} must not be empty`);
  }
  return value;
}

function caseInsensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]),
  );
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[+-]?\d+(?:\.0+)?$/u.test(raw.trim())) {
    throw new SettingsValidationError(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new SettingsValidationError(`${name} must be a safe integer`);
  }
  return value;
}

function postgresBigInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number | string {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim();
  if (!/^[+-]?\d+(?:\.0+)?$/u.test(normalized)) {
    throw new SettingsValidationError(`${name} must be an integer`);
  }
  const integerText = normalized.replace(/\.0+$/u, "");
  const value = Number(integerText);
  return Number.isSafeInteger(value) ? value : BigInt(integerText).toString();
}

function decimal(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw.trim().length === 0) {
    throw new SettingsValidationError(`${name} must be a number`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new SettingsValidationError(`${name} must be a finite number`);
  }
  return value;
}

function validateTimerSeconds(name: string, value: number): void {
  if (value <= 0 || value > MAX_TIMER_SECONDS) {
    throw new SettingsValidationError(
      `${name} must be greater than 0 and at most ${MAX_TIMER_SECONDS}`,
    );
  }
}

function boolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "t":
    case "yes":
    case "y":
    case "on":
      return true;
    case "0":
    case "false":
    case "f":
    case "no":
    case "n":
    case "off":
      return false;
    default:
      throw new SettingsValidationError(`${name} must be a boolean`);
  }
}

function reasoningEffort(
  env: NodeJS.ProcessEnv,
  name: string,
): ReasoningEffort {
  const value = env[name] ?? "medium";
  if (!REASONING_EFFORTS.has(value as ReasoningEffort)) {
    throw new SettingsValidationError(
      `${name} must be one of none, low, medium, high, xhigh`,
    );
  }
  return value as ReasoningEffort;
}

function validateModelRoute(
  name: "extraction" | "resolution",
  model: string,
  provider: string,
  nativeSchema: boolean,
): void {
  if (model.startsWith("deepseek/") && ["azure", "openai"].includes(provider)) {
    throw new SettingsValidationError(
      `${name}_model=${JSON.stringify(model)} is incompatible with ${name}_provider=${JSON.stringify(provider)}`,
    );
  }
  if (provider === "deepseek" && !model.startsWith("deepseek/")) {
    throw new SettingsValidationError(
      `${name}_provider='deepseek' requires a DeepSeek model, got ${JSON.stringify(model)}`,
    );
  }
  if (provider === "deepseek" && nativeSchema) {
    throw new SettingsValidationError(
      `${name}_native_schema requires a provider with structured-output support`,
    );
  }
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  if (env === process.env) loadLocalEnvFile();
  env = caseInsensitiveEnv(env);

  const extractionModel = env.EXTRACTION_MODEL ?? "openai/gpt-5.6-luna";
  const extractionProvider = env.EXTRACTION_PROVIDER ?? "openai";
  const extractionNativeSchema = boolean(env, "EXTRACTION_NATIVE_SCHEMA", true);
  const resolutionModel = env.RESOLUTION_MODEL ?? "openai/gpt-5.6-luna";
  const resolutionProvider = env.RESOLUTION_PROVIDER ?? "openai";
  const resolutionNativeSchema = boolean(env, "RESOLUTION_NATIVE_SCHEMA", true);
  const embeddingDimensions = integer(env, "EMBEDDING_DIMENSIONS", 1024);
  const databasePoolMinSize = integer(env, "DATABASE_POOL_MIN_SIZE", 1);
  const databasePoolMaxSize = integer(env, "DATABASE_POOL_MAX_SIZE", 8);
  const workerPollSeconds = decimal(env, "WORKER_POLL_SECONDS", 1);
  const workerConcurrency = integer(env, "WORKER_CONCURRENCY", 4);
  const workerMaxAttempts = integer(env, "WORKER_MAX_ATTEMPTS", 3);
  const workerRetryBackoffSeconds = decimal(
    env,
    "WORKER_RETRY_BACKOFF_SECONDS",
    2,
  );
  const requestTimeoutSeconds = decimal(env, "REQUEST_TIMEOUT_SECONDS", 120);
  const modelCallTimeoutSeconds = decimal(
    env,
    "MODEL_CALL_TIMEOUT_SECONDS",
    180,
  );

  if (databasePoolMaxSize < 2) {
    throw new SettingsValidationError(
      "database_pool_max_size must be at least 2",
    );
  }
  if (databasePoolMinSize < 0 || databasePoolMinSize > databasePoolMaxSize) {
    throw new SettingsValidationError(
      "database_pool_min_size must be between 0 and database_pool_max_size",
    );
  }
  if (embeddingDimensions !== 1024) {
    throw new SettingsValidationError(
      "voyage-4-large embeddings must use 1024 dimensions",
    );
  }
  if (workerConcurrency < 1) {
    throw new SettingsValidationError("worker_concurrency must be at least 1");
  }
  if (workerMaxAttempts < 1) {
    throw new SettingsValidationError("worker_max_attempts must be at least 1");
  }
  if (workerRetryBackoffSeconds < 0) {
    throw new SettingsValidationError(
      "worker_retry_backoff_seconds cannot be negative",
    );
  }
  validateTimerSeconds("worker_poll_seconds", workerPollSeconds);
  validateTimerSeconds("request_timeout_seconds", requestTimeoutSeconds);
  validateTimerSeconds("model_call_timeout_seconds", modelCallTimeoutSeconds);

  validateModelRoute(
    "extraction",
    extractionModel,
    extractionProvider,
    extractionNativeSchema,
  );
  validateModelRoute(
    "resolution",
    resolutionModel,
    resolutionProvider,
    resolutionNativeSchema,
  );

  return {
    databaseUrl: required(env, "DATABASE_URL"),
    reflectionApiKey: required(env, "REFLECTION_API_KEY", { nonempty: true }),
    openrouterApiKey: required(env, "OPENROUTER_API_KEY", { nonempty: true }),
    voyageApiKey: required(env, "VOYAGE_API_KEY", { nonempty: true }),
    openrouterBaseUrl: (
      env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
    ).replace(/\/+$/u, ""),
    voyageBaseUrl: (
      env.VOYAGE_BASE_URL ?? "https://api.voyageai.com/v1"
    ).replace(/\/+$/u, ""),
    extractionModel,
    extractionProvider,
    extractionReasoningEffort: reasoningEffort(
      env,
      "EXTRACTION_REASONING_EFFORT",
    ),
    extractionNativeSchema,
    resolutionModel,
    resolutionProvider,
    resolutionReasoningEffort: reasoningEffort(
      env,
      "RESOLUTION_REASONING_EFFORT",
    ),
    resolutionNativeSchema,
    embeddingModel: env.EMBEDDING_MODEL ?? "voyage-4-large",
    embeddingDimensions,
    databasePoolMinSize,
    databasePoolMaxSize,
    workerPollSeconds,
    workerConcurrency,
    workerMaxAttempts,
    workerRetryBackoffSeconds,
    workerLockId: postgresBigInt(env, "WORKER_LOCK_ID", 7_320_260_818_001),
    migrationLockId: postgresBigInt(
      env,
      "MIGRATION_LOCK_ID",
      7_320_260_818_002,
    ),
    requestTimeoutSeconds,
    modelCallTimeoutSeconds,
    migrationsDir: env.MIGRATIONS_DIR ?? "migrations",
    logLevel: env.LOG_LEVEL ?? "INFO",
  };
}
