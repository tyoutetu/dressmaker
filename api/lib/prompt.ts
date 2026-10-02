import type { NpcConfig } from "./npcs";

/**
 * One prompt used for every customer, plus per-customer notes from lib/npcs.ts:
 * migrate the dress design, never redesign the person, stay faithful to the
 * screenshot, and invent no decoration that is not visible in it.
 */
const BASE_PROMPT = `You are generating a preview image for a fashion-tailor game fan tool.

Task: The first image is a customer character from the 2D game "Dressmaker". The second image is a screenshot of a dress the player made in that game. Create ONE image of THE SAME character wearing THAT dress.

Strict requirements:
- Keep the character's identity exactly: same face, hairstyle, hair color, skin tone, expression style, body proportions and pose style as the first image.
- Keep the original game's 2D illustration art style.
- Replace ONLY the clothing with the dress from the second image.
- Faithfully reproduce the dress design from the second image: silhouette, main colors and color blocking, fabric appearance, pattern or print, sleeve shape, collar and neckline, skirt shape and hemline, and all visible decorations such as bows, lace, ribbons and trims.
- Do not redesign or reinterpret the dress. Do not add any decoration that is not visible in the dress screenshot.
- Keep the background simple and consistent with the original character image; do not invent a new detailed scene.
- Do not add any text, watermarks, logos, extra people, or extra limbs.
- Output a single clean character illustration.`;

export function buildPrompt(npc: NpcConfig): string {
  return `${BASE_PROMPT}\n\nAbout this customer (${npc.name}): ${npc.promptNotes}`;
}
