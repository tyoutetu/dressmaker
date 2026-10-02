/**
 * Customer (NPC) configuration — the single source of truth for both the web
 * frontend (which re-exports this file) and the API.
 *
 * To add or change a customer:
 *  1. Drop the display portrait in  web/public/npcs/<id>.webp   (shown on the card)
 *  2. Drop the reference art in    api/assets/npcs/<id>.webp    (sent to the model)
 *  3. Fill in `promptNotes` — what helps the model keep this customer looking
 *     like themselves. Only describe what the supplied art actually shows.
 *
 * `enabled: true` customers appear in the UI and can be generated. Everything
 * else is ignored, so the tool never shows a customer without real artwork.
 */
export interface NpcConfig {
  id: string;
  name: string;
  /** File path under the web frontend's public directory, relative to BASE_URL. */
  displayImage: string;
  /** Path relative to the api/ project root (read by the serverless function). */
  referenceImage: string;
  /**
   * Framing measured from the supplied 1024x1024 art (its alpha bounding box) so
   * the whole figure fills the card without cropping. Percentages are relative to
   * the square portrait frame; y is negative because the art sits in the lower half.
   */
  portrait: { scale: number; x: number; y: number };
  promptNotes: string;
  enabled: boolean;
}

/** Only customers with real reference art are shipped enabled. */
export const NPCS: NpcConfig[] = [
  {
    id: "rose",
    name: "Rose",
    displayImage: "npcs/rose.webp",
    referenceImage: "assets/npcs/rose.webp",
    portrait: { scale: 1.21, x: -1.2, y: -12 },
    promptNotes:
      "Rose has short curly red hair with a pencil tucked behind her ear, round wire glasses, and a warm friendly expression. Keep her exact face, hair, glasses and accessories from the reference image, and her usual calm, hands-clasped posing style.",
    enabled: true,
  },
  {
    id: "priya",
    name: "Priya",
    displayImage: "npcs/priya.webp",
    referenceImage: "assets/npcs/priya.webp",
    portrait: { scale: 1.21, x: 1.7, y: -12 },
    promptNotes:
      "Priya has long dark wavy hair falling over one shoulder, a slim choker, and a soft smiling expression. Keep her exact face, hair, hair colour and accessories from the reference image, and her usual hands-clasped posing style.",
    enabled: true,
  },
];

export const ENABLED_NPCS: NpcConfig[] = NPCS.filter((npc) => npc.enabled);

export function findNpc(id: string): NpcConfig | undefined {
  return ENABLED_NPCS.find((npc) => npc.id === id);
}
