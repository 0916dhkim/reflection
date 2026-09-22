import { chromium, webkit } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { assertLoopbackUrl, sessionRoute } from "./guards.mjs";
import { MARKER, PROMPT, TITLE } from "./fixture.mjs";

// No query values, credentials, header values, or response bodies enter artifacts.
export function browserURL(value, origin, directory) {
  const url = new URL(value);
  const http = ["http:", "https:"].includes(url.protocol);
  return {
    key: createHash("sha256").update(value).digest("hex").slice(0, 16),
    path: http ? url.pathname : `[${url.protocol}]`,
    queryKeys: http ? [...new Set(url.searchParams.keys())].sort() : [],
    sameOrigin: url.origin === origin,
    directoryMatches: url.searchParams.has("location[directory]")
      ? url.searchParams.get("location[directory]") === directory
      : null,
  };
}

export function browserError(value, password) {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of [
    password,
    encodeURIComponent(password),
    Buffer.from(`opencode:${password}`).toString("base64"),
  ]) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  return text
    .replace(/Basic\s+[^\s"']+/gi, "Basic [redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[url]")
    .replace(/\?[^\s"'<>]+/g, "?[query redacted]")
    .slice(0, 1200);
}

export function finiteAPIState(requests, document, now) {
  // /api/event is the pinned permanent SSE route. Do not wait for networkidle.
  const finite = requests.filter(
    (request) =>
      request.document === document &&
      request.sameOrigin &&
      request.path.startsWith("/api/") &&
      request.path !== "/api/event" &&
      !request.stream,
  );
  const pending = finite
    .filter((request) => request.endedAt == null)
    .map((request) => request.id);
  const configComplete = finite.some(
    (request) =>
      request.path === "/api/config" &&
      request.directoryMatches === true &&
      request.method === "GET" &&
      request.finished &&
      request.status >= 200 &&
      request.status < 300,
  );
  const lastActivity = Math.max(
    0,
    ...finite.map((request) => request.endedAt ?? request.startedAt),
  );
  return {
    pending,
    configComplete,
    ready: configComplete && pending.length === 0 && now - lastActivity >= 250,
  };
}

export function isReloadCancellation(request, navigation) {
  // Diagnostic classification only, never an exemption from the page-error gate.
  // A CORS message alone, a new-document request, or an HTTP rejection is not
  // evidence of a navigation cancellation.
  return Boolean(
    navigation?.kind === "reload" &&
      navigation.pending.includes(request.id) &&
      request.document === navigation.fromDocument &&
      request.sameOrigin &&
      request.method === "GET" &&
      request.failedAt != null &&
      navigation.completedAt != null &&
      request.failedAt >= navigation.startedAt &&
      request.failedAt <= navigation.completedAt &&
      (request.status == null ||
        (request.status >= 200 && request.status < 300)) &&
      !request.responseStatuses?.some(
        (status) => status === 401 || status === 403,
      ) &&
      /^(?:net::ERR_ABORTED|cancelled|canceled|Load cancelled)$/i.test(
        request.failure ?? "",
      ),
  );
}

// Self-contained for addInitScript and VM-only tests. Nothing observes fetch's
// promise settlement: even adding a catch would change unhandledrejection.
export function installBrowserLifecycleObserver({
  origin,
  directory,
  channel,
}) {
  const target = window;
  if (target !== target.top || target.location.origin !== origin) return;
  const originalFetch = target.fetch;
  const log = target.console.debug.bind(target.console);
  const documentTag = [...target.crypto.getRandomValues(new Uint32Array(4))]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
  const urlHref = Object.getOwnPropertyDescriptor(URL.prototype, "href").get;
  const requestURL = Object.getOwnPropertyDescriptor(
    Request.prototype,
    "url",
  ).get;
  let afterPagehide = false;
  let sequence = 0;
  const emit = (kind, fields = {}) => {
    try {
      if (sequence > 256) return;
      if (sequence === 256) {
        kind = "overflow";
        fields = {};
      }
      log(
        channel +
          JSON.stringify({
            kind,
            documentTag,
            sequence: ++sequence,
            at: target.performance.now(),
            timeOrigin: target.performance.timeOrigin,
            afterPagehide,
            ...fields,
          }),
      );
    } catch {
      /* Observation must never change application control flow. */
    }
  };
  const errorFields = (reason, message) => {
    // Do not stringify arbitrary rejection objects, invoke their getters, or
    // emit error text/stacks (which can embed credentials or response bodies).
    const own =
      reason != null &&
      (typeof reason === "object" || typeof reason === "function")
        ? Object.getOwnPropertyDescriptor(reason, "message")?.value
        : undefined;
    const text =
      typeof message === "string"
        ? message
        : typeof reason === "string"
          ? reason
          : typeof own === "string"
            ? own
            : "";
    return {
      reasonType: typeof reason,
      messagePresent: text.length > 0,
      accessControl: /due to access control checks/i.test(text),
      configMentioned: /\/api\/config(?:[?\s]|$)/.test(text),
    };
  };
  target.addEventListener(
    "pagehide",
    (event) => {
      afterPagehide = true;
      emit("pagehide", { persisted: event.persisted === true });
    },
    { capture: true },
  );
  target.addEventListener(
    "pageshow",
    (event) => {
      afterPagehide = false;
      emit("pageshow", { persisted: event.persisted === true });
    },
    { capture: true },
  );
  target.addEventListener(
    "error",
    (event) => {
      try {
        emit("window-error", {
          ...errorFields(event.error, event.message),
          javascriptErrorEvent: event instanceof target.ErrorEvent,
        });
      } catch {
        emit("window-error", { summaryUnavailable: true });
      }
    },
    { capture: true },
  );
  target.addEventListener(
    "unhandledrejection",
    (event) => {
      try {
        emit("unhandled-rejection", errorFields(event.reason));
      } catch {
        emit("unhandled-rejection", { summaryUnavailable: true });
      }
    },
    { capture: true },
  );
  target.fetch = function (...args) {
    try {
      const input = args[0];
      // Only native URL/Request accessors or primitive strings; never coerce a
      // caller's object twice, construct a Request, or inspect init/body/headers.
      const value =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? Reflect.apply(urlHref, input, [])
            : input instanceof Request
              ? Reflect.apply(requestURL, input, [])
              : null;
      if (value == null) emit("fetch", { targetUnavailable: true });
      else {
        const url = new URL(value, target.location.href);
        const http = ["http:", "https:"].includes(url.protocol);
        emit("fetch", {
          path: http ? url.pathname.slice(0, 256) : "[non-http]",
          queryKeys: http
            ? [...new Set(url.searchParams.keys())]
                .sort()
                .slice(0, 32)
                .map((key) => key.slice(0, 64))
            : [],
          sameOrigin: url.origin === origin,
          directoryMatches: url.searchParams.has("location[directory]")
            ? url.searchParams.get("location[directory]") === directory
            : null,
        });
      }
    } catch {
      emit("fetch", { targetUnavailable: true });
    }
    return Reflect.apply(originalFetch, this, args);
  };
  emit("installed");
}

export async function api(origin, password, path, body, options = {}) {
  assertLoopbackUrl(origin);
  const response = await fetch(new URL(`/api${path}`, origin), {
    method: body === undefined ? "GET" : "POST",
    ...options,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "content-type": "application/json",
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Native API ${path} returned ${response.status}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

export async function createNativeSession(origin, password, directory) {
  const payload = await api(origin, password, "/session", {
    title: TITLE,
    location: { directory },
    model: { providerID: "fixture", id: "fixture-model" },
  });
  if (typeof payload?.data?.id !== "string")
    throw Error("Native session create did not return an ID");
  return payload.data;
}

export async function verifyBrowserContract({
  origin,
  password,
  sessionId,
  signal,
  directory,
  results = {},
}) {
  assertLoopbackUrl(origin);
  for (const [name, browserType] of Object.entries({ chromium, webkit })) {
    const result = (results[name] = {
      outcome: "running",
      checks: { initial: {}, reload: {} },
      diagnostics: {
        requests: [],
        pageErrors: [],
        networkConsoleErrors: [],
        lifecycleEvents: [],
        navigations: [],
        overflow: false,
      },
    });
    const diagnostics = result.diagnostics;
    const started = performance.now();
    const now = () => Math.round(performance.now() - started);
    let browser;
    let collecting = true;
    let phase = "launch";
    let document = 0;
    let navigation;
    const tracked = new Map();
    const metadata = new Set();
    const redact = (value) => browserError(value, password);
    const lifecycleChannel = `__reflection_lifecycle_${randomUUID()}__`;
    // Inspector header collection is best effort and bounded. A null value
    // means unavailable, not proof that the browser omitted authentication.
    const headers = (request, response) => {
      const entry = tracked.get(request);
      if (!entry) return;
      const task = (async () => {
        let timer;
        try {
          const values = await Promise.race([
            Promise.all([request.allHeaders(), response?.allHeaders()]),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), 1000);
            }),
          ]);
          if (!values) return;
          const [sent, received] = values;
          entry.headersSampleStatus = response?.status() ?? null;
          entry.headers = {
            authorizationPresent: "authorization" in sent,
            originPresent: "origin" in sent,
            originMatches: sent.origin == null ? null : sent.origin === origin,
            corsAllowOriginPresent:
              received == null
                ? null
                : "access-control-allow-origin" in received,
            corsAllowOriginMatches:
              received?.["access-control-allow-origin"] == null
                ? null
                : received["access-control-allow-origin"] === origin,
            corsAllowCredentialsPresent:
              received == null
                ? null
                : "access-control-allow-credentials" in received,
            authChallengePresent:
              received == null ? null : "www-authenticate" in received,
          };
        } catch {
          /* Navigation may dispose inspector request metadata. */
        } finally {
          clearTimeout(timer);
        }
      })();
      metadata.add(task);
      void task.finally(() => metadata.delete(task));
    };
    const cancel = () => {
      void browser?.close().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      browser = await browserType.launch({ timeout: 20_000 });
      result.version = browser.version();
      signal?.throwIfAborted();
      const context = await browser.newContext({
        httpCredentials: { username: "opencode", password, origin },
        serviceWorkers: "block",
      });
      await context.addInitScript(installBrowserLifecycleObserver, {
        origin,
        directory,
        channel: lifecycleChannel,
      });
      await context.route("**/*", async (route) => {
        const target = new URL(route.request().url());
        const blocked =
          target.origin !== origin &&
          !["data:", "blob:"].includes(target.protocol);
        const entry = tracked.get(route.request());
        if (entry) entry.routing = blocked ? "blocked-origin" : "continue";
        if (blocked) return route.abort("blockedbyclient");
        return route.continue();
      });
      await context.routeWebSocket("**/*", (socket) => {
        const target = new URL(socket.url());
        if (target.origin === origin.replace("http:", "ws:"))
          socket.connectToServer();
        else socket.close();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const assets = new Map();
      const isAsset = (request) =>
        ["script", "stylesheet"].includes(request.resourceType()) &&
        new URL(request.url()).origin === origin;
      page.on("request", (request) => {
        if (!collecting) return;
        if (isAsset(request)) assets.set(request, null);
        if (tracked.size >= 1000) {
          diagnostics.overflow = true;
          return;
        }
        const entry = {
          id: tracked.size + 1,
          ...browserURL(request.url(), origin, directory),
          method: request.method(),
          type: request.resourceType(),
          document,
          startedAt: now(),
          phase,
          status: null,
          responseStatuses: [],
          endedAt: null,
          headers: null,
        };
        tracked.set(request, entry);
        diagnostics.requests.push(entry);
      });
      page.on("response", (response) => {
        if (!collecting) return;
        const entry = tracked.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        entry.responseStatuses.push(entry.status);
        entry.responseAt = now();
        entry.stream =
          response.headers()["content-type"]?.includes("text/event-stream") ??
          false;
        headers(response.request(), response);
      });
      page.on("requestfinished", (request) => {
        if (!collecting) return;
        const entry = tracked.get(request);
        if (entry) {
          entry.finished = true;
          entry.endedAt = now();
          entry.endPhase = phase;
        }
        if (isAsset(request))
          void request
            .response()
            .then((response) => assets.set(request, response?.status() ?? 0))
            .catch(() => assets.set(request, 0));
      });
      page.on("requestfailed", (request) => {
        if (!collecting) return;
        if (isAsset(request)) assets.set(request, 0);
        const entry = tracked.get(request);
        if (entry) {
          entry.failure = redact(request.failure()?.errorText ?? "unknown");
          entry.failedAt = entry.endedAt = now();
          entry.endPhase = phase;
          if (entry.status == null) headers(request);
        }
      });
      page.on("pageerror", (error) => {
        if (!collecting) return;
        if (diagnostics.pageErrors.length >= 50) {
          diagnostics.overflow = true;
          return;
        }
        // Correlate in memory before redaction; URL query values are never saved.
        const requestIds = [...tracked]
          .filter(([request]) =>
            [request.url(), request.url().replace(/^https?:\//, "")].some(
              (url) => error.message.includes(url),
            ),
          )
          .map(([, entry]) => entry.id);
        diagnostics.pageErrors.push({
          at: now(),
          document,
          phase,
          message: redact(error),
          requestIds,
        });
      });
      page.on("console", (message) => {
        if (
          collecting &&
          message.type() === "debug" &&
          message.text().startsWith(lifecycleChannel)
        ) {
          if (
            diagnostics.lifecycleEvents.length >= 768 ||
            message.text().length > 6000
          ) {
            diagnostics.overflow = true;
            return;
          }
          try {
            const record = JSON.parse(
              message.text().slice(lifecycleChannel.length),
            );
            // Hash the already-sanitized summary, not a URL/error containing
            // secrets. This is a grouping key, not the network request URL key.
            const {
              kind,
              documentTag,
              sequence,
              at,
              timeOrigin,
              afterPagehide,
              ...summary
            } = record;
            diagnostics.lifecycleEvents.push({
              kind,
              documentTag,
              sequence,
              at,
              timeOrigin,
              afterPagehide,
              ...summary,
              summaryHash: createHash("sha256")
                .update(JSON.stringify(summary))
                .digest("hex")
                .slice(0, 16),
              receivedAt: now(),
              observedDocument: document,
              phase,
            });
            if (kind === "overflow") diagnostics.overflow = true;
          } catch {
            diagnostics.overflow = true;
          }
          return;
        }
        if (
          !collecting ||
          message.type() !== "error" ||
          !/access control|CORS|cross-origin|401|403|failed to load resource/i.test(
            message.text(),
          )
        )
          return;
        if (diagnostics.networkConsoleErrors.length >= 50) {
          diagnostics.overflow = true;
          return;
        }
        diagnostics.networkConsoleErrors.push({
          at: now(),
          document,
          phase,
          message: redact(message.text()),
        });
      });
      page.on("framenavigated", (frame) => {
        if (!collecting || frame !== page.mainFrame() || !navigation) return;
        document = navigation.fromDocument + 1;
        navigation.committedAt = now();
        phase = `${navigation.kind}:committed`;
      });
      const route = `${origin}${sessionRoute(origin, sessionId)}`;
      for (const reload of [false, true]) {
        const kind = reload ? "reload" : "initial";
        phase = `${kind}:navigation`;
        navigation = {
          kind,
          fromDocument: document,
          startedAt: now(),
          pending: diagnostics.requests
            .filter((request) => request.endedAt == null)
            .map((request) => request.id),
        };
        diagnostics.navigations.push(navigation);
        // The event stream never becomes idle. Wait for history and meaningful
        // rendered content rather than an empty root or a settled network.
        const history = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/api/session/${sessionId}/message` && response.ok(),
        );
        await Promise.all([
          history,
          (reload
            ? page.reload({ waitUntil: "domcontentloaded" })
            : page.goto(route, { waitUntil: "domcontentloaded" })
          ).then(() => {
            navigation.completedAt = now();
          }),
        ]);
        result.checks[kind].history = true;
        phase = `${kind}:render`;
        await page
          .getByText(TITLE, { exact: true })
          .first()
          .waitFor({ state: "visible" });
        await page
          .getByText(PROMPT, { exact: true })
          .first()
          .waitFor({ state: "visible" });
        await page
          .getByText(MARKER, { exact: true })
          .first()
          .waitFor({ state: "visible" });
        await page.waitForLoadState("load");
        result.checks[kind].rendered = true;
        phase = `${kind}:finite-api`;
        // Rendering history does not imply that workspace configuration has
        // finished. Wait for the SPA's own config response and finite API work
        // before destroying this document. Do not inject a replacement fetch.
        const apiDeadline = now() + 10_000;
        while (!finiteAPIState(diagnostics.requests, document, now()).ready) {
          signal?.throwIfAborted();
          if (now() >= apiDeadline)
            throw Error("workspace config/finite API completion deadline");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        result.checks[kind].finiteAPI = true;
        await page.waitForFunction(() =>
          [...document.querySelectorAll('link[rel="stylesheet"]')].every(
            (link) => link.sheet != null,
          ),
        );
        const assetDeadline = Date.now() + 5000;
        while (
          [...assets.values()].some((status) => status == null) &&
          Date.now() < assetDeadline
        ) {
          signal?.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      result.assets = assets.size;
      if (
        !assets.size ||
        [...assets.values()].some(
          (status) => status == null || status < 200 || status >= 300,
        )
      )
        throw Error(
          "a requested bundled JS/CSS asset failed or remained pending",
        );
      if (diagnostics.overflow)
        throw Error("request diagnostic budget exceeded");
      if (diagnostics.pageErrors.length)
        throw Error(diagnostics.pageErrors[0].message);
      result.outcome = "passed";
    } catch (error) {
      result.outcome = "failed";
      result.error = redact(error);
      throw Error(`${name}: ${result.error}`);
    } finally {
      // Teardown intentionally cancels SSE; it is outside the assertions.
      collecting = false;
      diagnostics.lifecycleCoverage = {
        installedDocuments: [
          ...new Set(
            diagnostics.lifecycleEvents
              .filter((event) => event.kind === "installed")
              .map((event) => event.documentTag),
          ),
        ],
        pagehideDocuments: [
          ...new Set(
            diagnostics.lifecycleEvents
              .filter((event) => event.kind === "pagehide")
              .map((event) => event.documentTag),
          ),
        ],
      };
      for (const entry of diagnostics.requests) {
        if (entry.failedAt != null)
          entry.reloadCancellation = diagnostics.navigations.some((nav) =>
            isReloadCancellation(entry, nav),
          );
      }
      signal?.removeEventListener("abort", cancel);
      try {
        await browser?.close();
      } catch (error) {
        result.outcome = "failed";
        result.cleanupError = redact(error);
        throw Error(`${name}: browser cleanup failed`);
      } finally {
        await Promise.allSettled([...metadata]);
      }
    }
  }
  return results;
}
