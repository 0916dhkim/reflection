import { createHash, timingSafeEqual } from "node:crypto";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  ContractValidationError,
  codePointLength,
  JobResponseSchema,
  MAX_SEGMENT_TEXT_CHARS,
  SearchRequestSchema,
  SearchResponseSchema,
  SegmentCreateSchema,
  SegmentResponseSchema,
  SessionSegmentsResponseSchema,
  parseSearchRequest,
  parseSegmentCreate,
  parseSessionSegmentsResponse,
  type SearchRequest,
  type SegmentCreate,
} from "@reflection/shared/contracts";
import fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import {
  EmbeddingClient,
  ModelClient,
  UpstreamRequestError,
  UpstreamResponseError,
} from "./clients.js";
import {
  SettingsValidationError,
  loadSettings,
  type Settings,
} from "./config.js";
import { Database, JobNotRetryableError } from "./database.js";
import { ExtractionEngine } from "./extraction.js";
import { SearchService } from "./search.js";
import { ExtractionWorker } from "./worker.js";

export const REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export type AppDatabase = Pick<
  Database,
  | "open"
  | "close"
  | "healthcheck"
  | "enqueue"
  | "getJob"
  | "retryFailedJob"
  | "getSegment"
  | "sessionSegmentListing"
>;
export type AppWorker = Pick<ExtractionWorker, "start" | "stop" | "wake">;
export type AppSearchService = Pick<SearchService, "search">;

export interface AppDependencies {
  readonly database: AppDatabase;
  readonly worker: AppWorker;
  readonly searchService: AppSearchService;
}

declare module "fastify" {
  interface FastifyInstance {
    readonly reflection: AppDependencies;
  }
}

export interface CreateAppOptions {
  readonly settings?: Settings;
  readonly dependencies?: AppDependencies;
  readonly logger?: FastifyServerOptions["logger"];
}

export type ReflectionApp = FastifyInstance;

type TimingSafeComparator = (left: Buffer, right: Buffer) => boolean;
type ValidationLocation = string | number;

interface ValidationIssue {
  readonly path: ValidationLocation[];
  readonly message: string;
}

class RequestValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  readonly context: "body" | "path";

  constructor(
    issues: readonly ValidationIssue[],
    context: "body" | "path" = "body",
  ) {
    super("request validation failed");
    this.name = "RequestValidationError";
    this.issues = issues;
    this.context = context;
  }
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

const API_KEY_HEADER_SCHEMA = {
  type: "object",
  properties: { "x-api-key": { type: "string" } },
} as const;
const JOB_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["job_id"],
  properties: { job_id: { type: "integer" } },
} as const;
const SEGMENT_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segment_id"],
  properties: { segment_id: { type: "string", format: "uuid" } },
} as const;
const SESSION_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["session_id"],
  properties: { session_id: { type: "string" } },
} as const;

const KNOWN_ROUTES: ReadonlyArray<{
  pattern: RegExp;
  methods: readonly string[];
}> = [
  { pattern: /^\/healthz$/u, methods: ["GET"] },
  { pattern: /^\/openapi\.json$/u, methods: ["GET"] },
  { pattern: /^\/redoc$/u, methods: ["GET"] },
  { pattern: /^\/v1\/segments$/u, methods: ["POST"] },
  { pattern: /^\/v1\/jobs\/[^/]+\/retry$/u, methods: ["POST"] },
  { pattern: /^\/v1\/jobs\/[^/]+$/u, methods: ["GET"] },
  { pattern: /^\/v1\/segments\/[^/]+$/u, methods: ["GET"] },
  {
    pattern: /^\/v1\/sessions\/[^/]+\/segments$/u,
    methods: ["GET"],
  },
  { pattern: /^\/v1\/search$/u, methods: ["POST"] },
];

function keyDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function apiKeysMatch(
  supplied: string | undefined,
  expected: string,
  compare: TimingSafeComparator = timingSafeEqual,
): boolean {
  return compare(keyDigest(supplied ?? ""), keyDigest(expected));
}

function loggerLevel(value: string): string {
  const normalized = value.toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    warning: "warn",
    critical: "fatal",
    notset: "trace",
  };
  const level = aliases[normalized] ?? normalized;
  if (
    !["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(
      level,
    )
  ) {
    throw new SettingsValidationError(`invalid LOG_LEVEL: ${value}`);
  }
  return level;
}

function parseRequestContract<T>(
  parser: (value: unknown) => T,
  value: unknown,
): T {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new RequestValidationError(contractIssues(error));
    }
    throw error;
  }
}

function parseSegmentBody(value: unknown): SegmentCreate {
  if (typeof value === "object" && value !== null && "messages" in value) {
    const messages = (value as { messages?: unknown }).messages;
    if (Array.isArray(messages)) {
      let aggregate = 0;
      let allText = true;
      for (const message of messages) {
        if (
          typeof message !== "object" ||
          message === null ||
          !("text" in message) ||
          typeof message.text !== "string"
        ) {
          allText = false;
          break;
        }
        aggregate += codePointLength(message.text);
      }
      if (allText && aggregate > MAX_SEGMENT_TEXT_CHARS) {
        throw new RequestValidationError([
          {
            path: [],
            message: `combined message text cannot exceed ${MAX_SEGMENT_TEXT_CHARS} characters`,
          },
        ]);
      }
    }
  }
  return parseRequestContract(parseSegmentCreate, value);
}

function jsonPointerPath(value: string): ValidationLocation[] {
  if (value.length === 0) return [];
  return value
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((part) => (/^(?:0|[1-9]\d*)$/u.test(part) ? Number(part) : part));
}

function contractIssues(error: ContractValidationError): ValidationIssue[] {
  if (error.issues.length === 0) {
    return [{ path: [], message: error.message }];
  }
  return error.issues.map((issue) => ({
    path: jsonPointerPath(issue.path),
    message: issue.message,
  }));
}

function fastifyIssues(error: FastifyError): ValidationIssue[] {
  return (error.validation ?? []).map((issue) => {
    const path = jsonPointerPath(issue.instancePath);
    if (issue.keyword === "required") {
      const missing = issue.params.missingProperty;
      if (typeof missing === "string") path.push(missing);
    } else if (issue.keyword === "additionalProperties") {
      const additional = issue.params.additionalProperty;
      if (typeof additional === "string") path.push(additional);
    }
    return { path, message: issue.message ?? "Invalid value" };
  });
}

function validationBody(
  context: string,
  issues: readonly ValidationIssue[],
): { detail: Array<{ type: string; loc: ValidationLocation[]; msg: string }> } {
  return {
    detail: issues.map((issue) => ({
      type: "value_error",
      loc: [context, ...issue.path],
      msg: issue.message,
    })),
  };
}

function productionDependencies(
  settings: Settings,
  app: FastifyInstance,
): AppDependencies {
  const database = new Database(settings);
  const modelClient = new ModelClient(settings, globalThis.fetch, {
    info: (message, context) => app.log.info(context, message),
    warn: (message, context) => app.log.warn(context, message),
  });
  const embeddingClient = new EmbeddingClient(settings);
  const engine = new ExtractionEngine(database, modelClient, embeddingClient);
  const searchService = new SearchService(database, embeddingClient);
  const worker = new ExtractionWorker(database, engine, settings, {
    info: (message, ...values) => app.log.info({ values }, message),
    warn: (message, ...values) => app.log.warn({ values }, message),
    error: (message, ...values) => app.log.error({ err: values[0] }, message),
  });
  return { database, worker, searchService };
}

function registerDocumentation(app: FastifyInstance): void {
  app.register(swagger, {
    openapi: {
      info: { title: "Reflection", version: "0.1.0" },
    },
  });
  app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { url: "/openapi.json" },
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );
  app.get("/redoc", { schema: { hide: true } }, async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html><head><title>Reflection - ReDoc</title></head>
<body><redoc spec-url="/openapi.json"></redoc>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script></body></html>`);
  });
}

function registerRoutes(
  app: FastifyInstance,
  settings: Settings,
  dependencies: AppDependencies,
): void {
  app.get("/healthz", { schema: { hide: true } }, async (_request, reply) => {
    try {
      await dependencies.database.healthcheck();
      return { status: "ok" };
    } catch (error) {
      app.log.error({ err: error }, "database health check failed");
      return reply.code(503).send({ status: "unhealthy" });
    }
  });

  const expectedKeyDigest = keyDigest(settings.reflectionApiKey);
  app.register(
    async (v1) => {
      v1.addHook("onRequest", async (request) => {
        const header = request.headers["x-api-key"];
        const supplied = typeof header === "string" ? header : "";
        if (!timingSafeEqual(keyDigest(supplied), expectedKeyDigest)) {
          throw new HttpError(401, "invalid API key");
        }
      });

      v1.post(
        "/segments",
        {
          schema: {
            headers: API_KEY_HEADER_SCHEMA,
            body: SegmentCreateSchema,
            response: { 202: JobResponseSchema },
          },
          preValidation: async (request) => {
            request.body = parseSegmentBody(request.body);
          },
        },
        async (request, reply) => {
          const job = await dependencies.database.enqueue(
            request.body as SegmentCreate,
          );
          dependencies.worker.wake();
          return reply.code(202).send(job);
        },
      );

      v1.get(
        "/jobs/:job_id",
        {
          schema: {
            headers: API_KEY_HEADER_SCHEMA,
            params: JOB_PARAMS_SCHEMA,
            response: { 200: JobResponseSchema },
          },
        },
        async (request) => {
          const { job_id: jobId } = request.params as { job_id: number };
          const job = await dependencies.database.getJob(jobId);
          if (job === null) throw new HttpError(404, "job not found");
          return job;
        },
      );

      v1.post(
        "/jobs/:job_id/retry",
        {
          schema: {
            headers: API_KEY_HEADER_SCHEMA,
            params: JOB_PARAMS_SCHEMA,
            response: { 202: JobResponseSchema },
          },
        },
        async (request, reply) => {
          const { job_id: jobId } = request.params as { job_id: number };
          let job;
          try {
            job = await dependencies.database.retryFailedJob(jobId);
          } catch (error) {
            if (error instanceof JobNotRetryableError) {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
          if (job === null) throw new HttpError(404, "job not found");
          dependencies.worker.wake();
          return reply.code(202).send(job);
        },
      );

      v1.get(
        "/segments/:segment_id",
        {
          schema: {
            headers: API_KEY_HEADER_SCHEMA,
            params: SEGMENT_PARAMS_SCHEMA,
            response: { 200: SegmentResponseSchema },
          },
        },
        async (request) => {
          const { segment_id: segmentId } = request.params as {
            segment_id: string;
          };
          const segment = await dependencies.database.getSegment(segmentId);
          if (segment === null) throw new HttpError(404, "segment not found");
          return segment;
        },
      );

      v1.get(
        "/sessions/:session_id/segments",
        {
          schema: {
            headers: API_KEY_HEADER_SCHEMA,
            params: SESSION_PARAMS_SCHEMA,
            response: { 200: SessionSegmentsResponseSchema },
          },
        },
        async (request) => {
          const { session_id: sessionId } = request.params as {
            session_id: string;
          };
          const [segments, boundaries, targets] =
            await dependencies.database.sessionSegmentListing(sessionId);
          return parseSessionSegmentsResponse({
            manifest_version: 2,
            session_id: sessionId,
            segments,
            boundaries,
            targets,
          });
        },
      );

      v1.post(
        "/search",
        {
          schema: {
            headers: API_KEY_HEADER_SCHEMA,
            body: SearchRequestSchema,
            response: { 200: SearchResponseSchema },
          },
          preValidation: async (request) => {
            request.body = parseRequestContract(
              parseSearchRequest,
              request.body,
            );
          },
        },
        async (request) => {
          return dependencies.searchService.search(
            (request.body as SearchRequest).query,
          );
        },
      );
    },
    { prefix: "/v1" },
  );
}

function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(async (error: FastifyError, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ detail: error.message });
    }
    if (error instanceof RequestValidationError) {
      return reply.code(422).send(validationBody(error.context, error.issues));
    }
    if (error.validation !== undefined) {
      const context = error.validationContext === "params" ? "path" : "body";
      return reply
        .code(422)
        .send(validationBody(context, fastifyIssues(error)));
    }
    if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply
        .code(422)
        .send(
          validationBody("body", [{ path: [], message: "JSON decode error" }]),
        );
    }
    if (error instanceof UpstreamResponseError) {
      app.log.warn({ errorType: error.name }, "upstream returned invalid data");
      return reply.code(502).send({ detail: "invalid upstream response" });
    }
    if (error instanceof UpstreamRequestError) {
      app.log.warn({ errorType: error.name }, "upstream request failed");
      return reply.code(502).send({ detail: "upstream request failed" });
    }
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ detail: error.message });
    }

    app.log.error({ err: error }, "request failed");
    return reply
      .code(500)
      .type("text/plain; charset=utf-8")
      .send("Internal Server Error");
  });

  app.setNotFoundHandler(async (request, reply) => {
    const [path = "", query] = request.url.split("?", 2);
    const withoutSlash =
      path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    const route = KNOWN_ROUTES.find((item) => item.pattern.test(withoutSlash));
    if (route !== undefined && withoutSlash !== path) {
      return reply.redirect(
        `${withoutSlash}${query === undefined ? "" : `?${query}`}`,
        307,
      );
    }
    if (route !== undefined && !route.methods.includes(request.method)) {
      return reply
        .header("allow", route.methods.join(", "))
        .code(405)
        .send({ detail: "Method Not Allowed" });
    }
    return reply.code(404).send({ detail: "Not Found" });
  });
}

export function createApp(options: CreateAppOptions = {}): ReflectionApp {
  const settings = options.settings ?? loadSettings();
  const app = fastify({
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
    exposeHeadRoutes: false,
    trustProxy: true,
    logger:
      options.logger === undefined
        ? { level: loggerLevel(settings.logLevel) }
        : options.logger,
  });
  app.addContentTypeParser(
    "*",
    { parseAs: "string" },
    (request, body, done) => {
      if (request.headers["content-type"] !== undefined) {
        done(null, body);
        return;
      }
      try {
        const text = typeof body === "string" ? body : body.toString("utf8");
        done(null, JSON.parse(text) as unknown);
      } catch {
        done(
          new RequestValidationError([
            { path: [], message: "JSON decode error" },
          ]),
        );
      }
    },
  );
  const dependencies =
    options.dependencies ?? productionDependencies(settings, app);
  app.decorate("reflection", dependencies);

  let databaseClosed = false;
  let workerStarted = false;
  app.addHook("onReady", async () => {
    try {
      await dependencies.database.open();
      dependencies.worker.start();
      workerStarted = true;
    } catch (error) {
      await dependencies.database.close();
      databaseClosed = true;
      throw error;
    }
  });
  app.addHook("onClose", async () => {
    let shutdownError: unknown;
    if (workerStarted) {
      try {
        await dependencies.worker.stop();
      } catch (error) {
        shutdownError = error;
      }
    }
    if (!databaseClosed) {
      try {
        await dependencies.database.close();
        databaseClosed = true;
      } catch (error) {
        shutdownError ??= error;
      }
    }
    if (shutdownError !== undefined) throw shutdownError;
  });

  registerDocumentation(app);
  registerRoutes(app, settings, dependencies);
  registerErrorHandling(app);
  return app;
}
