const value = process.env.REFLECTION_TEST_DATABASE_URL;
if (!value)
  throw new Error(
    "REFLECTION_TEST_DATABASE_URL is required and must identify a disposable database",
  );
let url;
try {
  url = new URL(value);
} catch {
  // URL parser exceptions include the original input, which can contain a password.
  throw new Error(
    "REFLECTION_TEST_DATABASE_URL must be a valid disposable PostgreSQL URL",
  );
}
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  !/^\/[a-z0-9_]*(?:test|disposable)[a-z0-9_]*$/i.test(url.pathname) ||
  url.search
) {
  throw new Error(
    "Refusing destructive integration tests: require a loopback PostgreSQL URL with test/disposable in the database name and no query overrides",
  );
}
