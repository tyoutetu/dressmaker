import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import type { Sql } from "../lib/db.js";
import type { ImageGenerationProvider } from "../lib/provider.js";

/**
 * Real Postgres semantics without a server: PGlite is an embedded Postgres that
 * runs the actual api/sql/schema.sql, so the quota function under test is the
 * same SQL production runs.
 */

export interface TestDb {
  sql: Sql;
  pglite: PGlite;
  close(): Promise<void>;
}

export function neonLike(pg: PGlite): Sql {
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
    let text = strings[0];
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      text += `$${params.length}${strings[i + 1]}`;
    }
    const result = await pg.query(text, params);
    return result.rows;
  };
  Object.assign(tag, {
    query: async (text: string, params: unknown[] = []) => {
      const result = await pg.query(text, params);
      return { rows: result.rows };
    },
  });
  return tag as unknown as Sql;
}

export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
  await pglite.exec(schema);
  return {
    pglite,
    sql: neonLike(pglite),
    close: () => pglite.close(),
  };
}

/** Restores every environment variable it touches, even when a test throws. */
export async function withEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    previous.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A tiny valid JPEG, used as a stand-in for a dress screenshot. */
export async function tinyJpeg(color = "#c2586e"): Promise<Buffer> {
  return sharp({ create: { width: 96, height: 72, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

/** A tiny valid PNG, used as a stand-in for provider output. */
export async function tinyPng(color = "#4d7c5f"): Promise<Buffer> {
  return sharp({ create: { width: 128, height: 128, channels: 3, background: color } })
    .png()
    .toBuffer();
}

export interface FakeProvider extends ImageGenerationProvider {
  calls: number;
  lastPrompt?: string;
  lastReferenceMime?: string;
}

/** Deterministic provider stand-in; never touches the network. */
export function fakeProvider(
  behaviour: { fail?: Error; png?: Buffer } = {},
): FakeProvider {
  const provider: FakeProvider = {
    id: "fake",
    model: "fake-model",
    calls: 0,
    async generate(input) {
      provider.calls += 1;
      provider.lastPrompt = input.prompt;
      provider.lastReferenceMime = input.npcReference.mime;
      if (behaviour.fail) throw behaviour.fail;
      return {
        image: behaviour.png ?? (await tinyPng()),
        latencyMs: 12,
        estimatedCost: 0.01,
      };
    },
  };
  return provider;
}

export function generateForm(
  fields: Record<string, string | Blob>,
  headers: Record<string, string> = {},
): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request("http://localhost:3000/api/generate", {
    method: "POST",
    body: form,
    headers: {
      origin: "http://localhost:5173",
      "x-vercel-forwarded-for": "203.0.113.7",
      ...headers,
    },
  });
}
