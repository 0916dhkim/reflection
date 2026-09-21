export function assertFixtureEnvironment(environment) {
  for (const [key, value] of Object.entries({
    DATABASE_URL: "postgresql://fixture:fixture-only@fixture-pg:5432/fixture",
    REFLECTION_API_KEY: "fixture-reflection",
    OPENROUTER_API_KEY: "fixture-openrouter",
    VOYAGE_API_KEY: "fixture-voyage",
    OPENROUTER_BASE_URL: "http://127.0.0.1:4101/v1",
    VOYAGE_BASE_URL: "http://127.0.0.1:4102/v1",
    HOME: "/state/home",
  }))
    if (environment[key] !== value)
      throw new Error(`Refusing non-fixture ${key}`);
}
