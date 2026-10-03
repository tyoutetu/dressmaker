/**
 * Applies sql/schema.sql to the Neon database (idempotent, CREATE IF NOT EXISTS).
 * Usage: DATABASE_URL=postgres://... npm run db:init
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "@neondatabase/serverless";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const schema = await readFile(path.resolve("sql/schema.sql"), "utf8");

  const pool = new Pool({ connectionString: url });
  try {
    // pg-style simple query allows multiple statements in one round trip.
    await pool.query(schema);
    console.log(
      "Schema applied: generations, feedback, usage_daily, global_usage_daily, reserve_generation_quota().",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
