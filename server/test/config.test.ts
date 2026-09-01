import { describe, expect, test } from "vitest";

import { SettingsValidationError, loadSettings } from "../src/config.js";

function requiredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://unused",
    REFLECTION_API_KEY: "reflection-secret",
    OPENROUTER_API_KEY: "openrouter-secret",
    VOYAGE_API_KEY: "voyage-secret",
    ...overrides,
  };
}

describe("loadSettings", () => {
  test("loads the production defaults and strips URL suffixes", () => {
    const settings = loadSettings(
      requiredEnv({
        OPENROUTER_BASE_URL: "https://openrouter.example/v1///",
        VOYAGE_BASE_URL: "https://voyage.example/v1/",
      }),
    );

    expect(settings).toEqual({
      databaseUrl: "postgresql://unused",
      reflectionApiKey: "reflection-secret",
      openrouterApiKey: "openrouter-secret",
      voyageApiKey: "voyage-secret",
      openrouterBaseUrl: "https://openrouter.example/v1",
      voyageBaseUrl: "https://voyage.example/v1",
      extractionModel: "openai/gpt-5.6-luna",
      extractionProvider: "openai",
      extractionReasoningEffort: "medium",
      extractionNativeSchema: true,
      resolutionModel: "openai/gpt-5.6-luna",
      resolutionProvider: "openai",
      resolutionReasoningEffort: "medium",
      resolutionNativeSchema: true,
      embeddingModel: "voyage-4-large",
      embeddingDimensions: 1024,
      databasePoolMinSize: 1,
      databasePoolMaxSize: 8,
      workerPollSeconds: 1,
      workerConcurrency: 4,
      workerMaxAttempts: 3,
      workerRetryBackoffSeconds: 2,
      workerLockId: 7_320_260_818_001,
      migrationLockId: 7_320_260_818_002,
      requestTimeoutSeconds: 120,
      modelCallTimeoutSeconds: 180,
      migrationsDir: "migrations",
      logLevel: "INFO",
    });
  });

  test("parses all supported scalar overrides", () => {
    const settings = loadSettings(
      requiredEnv({
        EXTRACTION_REASONING_EFFORT: "xhigh",
        EXTRACTION_NATIVE_SCHEMA: "off",
        RESOLUTION_REASONING_EFFORT: "none",
        RESOLUTION_NATIVE_SCHEMA: "1",
        DATABASE_POOL_MIN_SIZE: "0",
        DATABASE_POOL_MAX_SIZE: "12",
        WORKER_CONCURRENCY: "6",
        WORKER_POLL_SECONDS: "0.25",
        WORKER_MAX_ATTEMPTS: "5.0",
        WORKER_RETRY_BACKOFF_SECONDS: "0",
        REQUEST_TIMEOUT_SECONDS: "45.5",
        MODEL_CALL_TIMEOUT_SECONDS: "90",
      }),
    );

    expect(settings).toMatchObject({
      extractionReasoningEffort: "xhigh",
      extractionNativeSchema: false,
      resolutionReasoningEffort: "none",
      resolutionNativeSchema: true,
      databasePoolMinSize: 0,
      databasePoolMaxSize: 12,
      workerConcurrency: 6,
      workerPollSeconds: 0.25,
      workerMaxAttempts: 5,
      workerRetryBackoffSeconds: 0,
      requestTimeoutSeconds: 45.5,
      modelCallTimeoutSeconds: 90,
    });
  });

  test("supports case-insensitive environment and PostgreSQL-sized lock IDs", () => {
    const settings = loadSettings(
      requiredEnv({
        reflection_api_key: "lowercase-key",
        worker_lock_id: "90071992547409930",
      }),
    );

    expect(settings.reflectionApiKey).toBe("lowercase-key");
    expect(settings.workerLockId).toBe("90071992547409930");
  });

  test.each([
    ["WORKER_POLL_SECONDS", "NaN"],
    ["REQUEST_TIMEOUT_SECONDS", "inf"],
    ["MODEL_CALL_TIMEOUT_SECONDS", "-Infinity"],
  ])("rejects non-finite %s", (name, value) => {
    expect(() => loadSettings(requiredEnv({ [name]: value }))).toThrow(
      `${name} must be a finite number`,
    );
  });

  test.each([
    ["REFLECTION_API_KEY", ""],
    ["OPENROUTER_API_KEY", ""],
    ["VOYAGE_API_KEY", ""],
  ])(
    "rejects an empty required secret without exposing other secrets",
    (name, value) => {
      expect(() => loadSettings(requiredEnv({ [name]: value }))).toThrow(
        new SettingsValidationError(`${name} must not be empty`),
      );
      try {
        loadSettings(requiredEnv({ [name]: value }));
      } catch (error) {
        expect(String(error)).not.toContain("openrouter-secret");
        expect(String(error)).not.toContain("voyage-secret");
      }
    },
  );

  test("requires every configured secret but permits an empty database URL", () => {
    expect(() =>
      loadSettings({
        DATABASE_URL: "postgresql://unused",
        REFLECTION_API_KEY: "test",
        OPENROUTER_API_KEY: "test",
      }),
    ).toThrow("VOYAGE_API_KEY is required");
    expect(loadSettings(requiredEnv({ DATABASE_URL: "" })).databaseUrl).toBe(
      "",
    );
  });

  test.each([
    [
      { DATABASE_POOL_MAX_SIZE: "1" },
      "database_pool_max_size must be at least 2",
    ],
    [
      { EMBEDDING_DIMENSIONS: "768" },
      "voyage-4-large embeddings must use 1024 dimensions",
    ],
    [{ WORKER_CONCURRENCY: "0" }, "worker_concurrency must be at least 1"],
    [{ WORKER_CONCURRENCY: "-1" }, "worker_concurrency must be at least 1"],
    [
      { WORKER_CONCURRENCY: "invalid" },
      "WORKER_CONCURRENCY must be an integer",
    ],
    [{ WORKER_CONCURRENCY: "1.5" }, "WORKER_CONCURRENCY must be an integer"],
    [{ WORKER_MAX_ATTEMPTS: "0" }, "worker_max_attempts must be at least 1"],
    [
      { WORKER_RETRY_BACKOFF_SECONDS: "-0.1" },
      "worker_retry_backoff_seconds cannot be negative",
    ],
    [
      { DATABASE_POOL_MIN_SIZE: "-1" },
      "database_pool_min_size must be between 0 and database_pool_max_size",
    ],
    [
      { DATABASE_POOL_MIN_SIZE: "9", DATABASE_POOL_MAX_SIZE: "8" },
      "database_pool_min_size must be between 0 and database_pool_max_size",
    ],
    [
      { WORKER_POLL_SECONDS: "0" },
      "worker_poll_seconds must be greater than 0",
    ],
    [
      { REQUEST_TIMEOUT_SECONDS: "2147483.648" },
      "request_timeout_seconds must be greater than 0",
    ],
    [
      { MODEL_CALL_TIMEOUT_SECONDS: "-1" },
      "model_call_timeout_seconds must be greater than 0",
    ],
    [
      { EXTRACTION_REASONING_EFFORT: "extreme" },
      "EXTRACTION_REASONING_EFFORT must be one of none, low, medium, high, xhigh",
    ],
    [
      { EXTRACTION_NATIVE_SCHEMA: "sometimes" },
      "EXTRACTION_NATIVE_SCHEMA must be a boolean",
    ],
  ])("preserves scalar validation for %o", (overrides, message) => {
    expect(() => loadSettings(requiredEnv(overrides))).toThrow(message);
  });

  test.each([
    [
      {
        EXTRACTION_MODEL: "deepseek/v3",
        EXTRACTION_PROVIDER: "openai",
      },
      'extraction_model="deepseek/v3" is incompatible with extraction_provider="openai"',
    ],
    [
      {
        RESOLUTION_MODEL: "openai/gpt-5.6-luna",
        RESOLUTION_PROVIDER: "deepseek",
        RESOLUTION_NATIVE_SCHEMA: "false",
      },
      "resolution_provider='deepseek' requires a DeepSeek model",
    ],
    [
      {
        RESOLUTION_MODEL: "deepseek/v3",
        RESOLUTION_PROVIDER: "deepseek",
      },
      "resolution_native_schema requires a provider with structured-output support",
    ],
  ])("validates model and provider profiles together", (overrides, message) => {
    expect(() => loadSettings(requiredEnv(overrides))).toThrow(message);
  });
});
