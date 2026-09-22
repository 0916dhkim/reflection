import { chromium, webkit } from "playwright";
import { assertLoopbackUrl, sessionRoute } from "./guards.mjs";
import { MARKER, PROMPT, TITLE } from "./fixture.mjs";

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
}) {
  assertLoopbackUrl(origin);
  const results = {};
  for (const [name, browserType] of Object.entries({ chromium, webkit })) {
    signal?.throwIfAborted();
    const browser = await browserType.launch({ timeout: 20_000 });
    const cancel = () => {
      void browser.close().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const context = await browser.newContext({
        httpCredentials: { username: "opencode", password, origin },
        serviceWorkers: "block",
      });
      await context.route("**/*", async (route) => {
        const target = new URL(route.request().url());
        if (
          target.origin !== origin &&
          !["data:", "blob:"].includes(target.protocol)
        )
          return route.abort("blockedbyclient");
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
      const errors = [];
      const isAsset = (request) =>
        ["script", "stylesheet"].includes(request.resourceType()) &&
        new URL(request.url()).origin === origin;
      page.on("request", (request) => {
        if (isAsset(request)) assets.set(request, null);
      });
      page.on("requestfinished", (request) => {
        if (isAsset(request))
          void request
            .response()
            .then((response) => assets.set(request, response?.status() ?? 0))
            .catch(() => assets.set(request, 0));
      });
      page.on("requestfailed", (request) => {
        if (isAsset(request)) assets.set(request, 0);
      });
      page.on("pageerror", (error) => errors.push(error.message));
      const route = `${origin}${sessionRoute(origin, sessionId)}`;
      for (const reload of [false, true]) {
        // The event stream never becomes idle. Wait for history and meaningful
        // rendered content rather than an empty root or a settled network.
        const history = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/api/session/${sessionId}/message` && response.ok(),
        );
        await Promise.all([
          history,
          reload
            ? page.reload({ waitUntil: "domcontentloaded" })
            : page.goto(route, { waitUntil: "domcontentloaded" }),
        ]);
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
      if (
        !assets.size ||
        [...assets.values()].some(
          (status) => status == null || status < 200 || status >= 300,
        )
      )
        throw Error(
          `${name}: a requested bundled JS/CSS asset failed or remained pending`,
        );
      if (errors.length) throw Error(`${name}: ${errors[0]}`);
      results[name] = {
        assets: assets.size,
        version: browser.version(),
        history: true,
        reload: true,
        renderedAssistant: true,
      };
      await context.close();
    } finally {
      signal?.removeEventListener("abort", cancel);
      await browser.close();
    }
  }
  return results;
}
