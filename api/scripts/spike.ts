/**
 * Paid-quality spike: prove the model can migrate a dress onto ONE customer
 * before you rely on it. Every image it renders is billed.
 *
 * Usage (from api/):
 *   npm run spike -- --npc rose --out ../spike-out dress1.png dress2.png ...
 *   npm run spike -- --npc rose --ref path/to/npc.png --provider openai dress1.png
 *
 * Requires the key for the selected provider (default: DASHSCOPE_API_KEY for
 * qwen; AI_PROVIDER=gemini|openai uses GEMINI_API_KEY / OPENAI_API_KEY).
 * Every image it renders is billed, so run it deliberately.
 * Prints latency and estimated cost per image, and writes results to --out.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NPCS } from "../lib/npcs";
import { buildPrompt, NEGATIVE_PROMPT } from "../lib/prompt";
import { getProvider, type ImageInput } from "../lib/provider";
import { loadNpcReference } from "../lib/npcAssets";
import sharp from "sharp";

interface Args {
  npcId: string;
  out: string;
  ref?: string;
  provider?: string;
  dresses: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { npcId: "rose", out: "../spike-out", dresses: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--npc") args.npcId = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--provider") {
      process.env.AI_PROVIDER = argv[++i];
    } else if (!a.startsWith("--")) args.dresses.push(a);
  }
  return args;
}

async function toJpegBuffer(file: string): Promise<Buffer> {
  const raw = await readFile(file);
  return sharp(raw).rotate().jpeg({ quality: 90 }).toBuffer();
}

/** Any reference image is normalized to PNG, matching what the API sends. */
async function toPngInput(file: string): Promise<ImageInput> {
  const raw = await readFile(file);
  return { data: await sharp(raw).rotate().png().toBuffer(), mime: "image/png" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dresses.length === 0) {
    console.error("No dress screenshots given. Usage: npm run spike -- --npc rose dress1.png dress2.png ...");
    process.exit(1);
  }

  const npc = NPCS.find((n) => n.id === args.npcId);
  if (!npc) {
    console.error(`Unknown npc "${args.npcId}". Known ids: ${NPCS.map((n) => n.id).join(", ")}`);
    process.exit(1);
  }

  const provider = getProvider();
  const npcReference = await (args.ref
    ? toPngInput(args.ref)
    : loadNpcReference(npc.referenceImage));
  const prompt = buildPrompt(npc);

  await mkdir(args.out, { recursive: true });

  console.log(`Provider: ${provider.id} / ${provider.model}`);
  console.log(`NPC: ${npc.name} (${npc.id}), ${args.dresses.length} dress(es)\n`);

  let totalMs = 0;
  let ok = 0;
  const rows: string[] = ["dress,latency_s,est_cost_usd,output"];

  for (const dress of args.dresses) {
    const label = path.basename(dress);
    process.stdout.write(`→ ${label} ... `);
    try {
      const screenshot = await toJpegBuffer(dress);
      const startedAt = Date.now();
      const result = await provider.generate({
        npcReference,
        dressScreenshot: { data: screenshot, mime: "image/jpeg" },
        prompt,
        negativePrompt: NEGATIVE_PROMPT,
        signal: AbortSignal.timeout(120_000),
      });
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const outPath = path.join(args.out, `${npc.id}-${path.parse(label).name}.png`);
      await writeFile(outPath, result.image);
      totalMs += Date.now() - startedAt;
      ok += 1;
      const cost = result.estimatedCost === undefined ? "" : result.estimatedCost.toFixed(4);
      console.log(`${seconds}s, ${cost ? `~$${cost}` : "cost n/a"} → ${outPath}`);
      rows.push(`${label},${seconds},${cost},${path.basename(outPath)}`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      rows.push(`${label},FAILED,,`);
    }
  }

  const avg = ok > 0 ? (totalMs / ok / 1000).toFixed(1) : "n/a";
  console.log(`\nDone: ${ok}/${args.dresses.length} succeeded, avg ${avg}s per image.`);
  console.log(
    `Inspect ${args.out}/ and keep only if most results clearly show the original dress.`,
  );
  await writeFile(path.join(args.out, "results.csv"), rows.join("\n") + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
