import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function loadEnv(filePath = path.join(rootDir, ".env")) {
  if (!existsSync(filePath)) return;
  const raw = readFile(filePath, "utf8");
  return raw.then((text) => {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      let value = rawValue.trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  });
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function rows(sqlite, table) {
  return sqlite.prepare(`SELECT * FROM ${table}`).all();
}

function count(sqlite, table) {
  return Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
}

function jsonStore(value) {
  if (typeof value !== "string") return JSON.stringify(value || {});
  JSON.parse(value);
  return value;
}

async function upsert(client, table, row, conflictColumns, updateColumns = Object.keys(row)) {
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column]);
  const placeholders = columns.map((column, index) => column === "data" ? `$${index + 1}::jsonb` : `$${index + 1}`);
  const updates = updateColumns
    .filter((column) => !conflictColumns.includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  const sql = `
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES (${placeholders.join(", ")})
    ON CONFLICT (${conflictColumns.join(", ")})
    ${updates ? `DO UPDATE SET ${updates}` : "DO NOTHING"}
  `;
  await client.query(sql, values);
}

async function main() {
  await loadEnv();
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run") || !apply;
  const sqlitePath = path.resolve(rootDir, argValue("--sqlite", "data/app.db"));
  const databaseUrl = process.env.DATABASE_URL;

  if (!existsSync(sqlitePath)) throw new Error(`SQLite database not found at ${sqlitePath}`);
  if (!databaseUrl) throw new Error("DATABASE_URL is required. Put your Supabase connection string in .env or the shell.");

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const tables = [
    "users",
    "user_stores",
    "usage_events",
    "feedback_entries",
    "company_catalog",
    "company_requests",
    "email_digest_sends"
  ];

  console.log("SQLite source:", sqlitePath);
  console.log("Mode:", dryRun ? "dry-run" : "apply");
  console.log("Source counts:");
  for (const table of tables) console.log(`- ${table}: ${count(sqlite, table)}`);

  const { Pool } = pg;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false }
  });
  const client = await pool.connect();
  try {
    await client.query(await readFile(path.join(rootDir, "migrations/001_initial_supabase.sql"), "utf8"));

    if (!apply) {
      console.log("Dry run complete. Re-run with --apply to write rows to Supabase.");
      return;
    }

    await client.query("BEGIN");

    for (const row of rows(sqlite, "users")) {
      await upsert(client, "users", row, ["id"]);
    }

    for (const row of rows(sqlite, "user_stores")) {
      await upsert(client, "user_stores", {
        ...row,
        data: jsonStore(row.data)
      }, ["user_id"]);
    }

    for (const row of rows(sqlite, "usage_events")) {
      await upsert(client, "usage_events", row, ["id"]);
    }

    for (const row of rows(sqlite, "feedback_entries")) {
      await upsert(client, "feedback_entries", row, ["id"]);
    }

    for (const row of rows(sqlite, "company_catalog")) {
      await upsert(client, "company_catalog", {
        test_status: null,
        test_summary: null,
        last_tested_at: null,
        ...row
      }, ["id"]);
    }

    for (const row of rows(sqlite, "company_requests")) {
      await upsert(client, "company_requests", row, ["id"]);
    }

    for (const row of rows(sqlite, "email_digest_sends")) {
      await upsert(client, "email_digest_sends", row, ["id"]);
    }

    await client.query("COMMIT");

    console.log("Supabase validation counts:");
    for (const table of tables) {
      const result = await client.query(`SELECT COUNT(*) AS count FROM ${table}`);
      console.log(`- ${table}: ${result.rows[0].count}`);
    }
  } catch (error) {
    if (apply) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
