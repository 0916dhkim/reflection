import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";

export async function applyMigrations(
  connection: Pick<PoolClient, "query">,
  directory: string,
  lockId: number | string,
): Promise<void> {
  const migrationNames = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (migrationNames.length === 0) {
    throw new Error(`no SQL migrations found in ${directory}`);
  }
  const migrations = await Promise.all(
    migrationNames.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
      };
    }),
  );
  await connection.query("BEGIN");
  try {
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SELECT pg_advisory_xact_lock($1)", [lockId]);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS reflection_schema_migrations (
          name TEXT PRIMARY KEY,
          checksum CHAR(64) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const recorded = new Map(
      (
        await connection.query<{ name: string; checksum: string }>(
          "SELECT name, checksum FROM reflection_schema_migrations",
        )
      ).rows.map((row) => [row.name, row.checksum]),
    );
    for (const migration of migrations) {
      const checksum = recorded.get(migration.name);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new Error(`migration checksum mismatch for ${migration.name}`);
        }
        continue;
      }
      await connection.query(migration.sql);
      await connection.query(
        "INSERT INTO reflection_schema_migrations (name, checksum) VALUES ($1, $2)",
        [migration.name, migration.checksum],
      );
    }
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
}
