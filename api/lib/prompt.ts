import type { NpcConfig } from "./npcs";

/**
 * One prompt used for every customer, plus per-customer notes from lib/npcs.ts:
 * migrate the dress design, never redesign the person, stay faithful to the
 * screenshot, and invent no decoration that is not visible in it.
 *
 * The clothing clauses are deliberately forceful. A live spike showed the model
 * treating "keep the character's identity" as covering her wardrobe: on
 * sleeveless and short-sleeved dresses it kept the customer's own long sleeves
 * underneath, because the reference art shows her in them. Identity therefore
 * has to be scoped to the person explicitly, and the garment swap stated as a
 * complete replacement rather than a change of outer layer.
 */
const BASE_PROMPT = `You are generating a preview image for a fashion-tailor game fan tool.

Task: The first image is a customer character from the 2D game "Dressmaker". The second image is a screenshot of a dress the player made in that game. Create ONE image of THE SAME character wearing THAT dress.

Strict requirements:
- Keep the character's identity exactly: same face, hairstyle, hair color, skin tone, expression style, body proportions and pose style as the first image. Identity means the PERSON — her face, hair and body — not the clothes she happens to be wearing.
- Keep the original game's 2D illustration art style.
- Replace her clothing COMPLETELY with the dress from the second image. Nothing of her own outfit may survive: not the top, not the skirt, not the collar, not any layer worn underneath. Do not wear two outfits at once, and do not place the new dress over the old one.
- Reproduce the arms exactly as the second image shows them. If that dress is sleeveless or strapless, her shoulders and arms must be bare — never add sleeves that are not in the second image, and never keep her original sleeves showing beneath. If it has sleeves, match their length, shape (fitted, puffed, bell, ruffled), colour and cuffs precisely.
- Faithfully reproduce the rest of the dress design from the second image: silhouette, main colors and color blocking, fabric appearance, pattern or print, collar and neckline, skirt shape and hemline, and all visible decorations such as bows, lace, ribbons and trims.
- Do not redesign or reinterpret the dress. Do not add any decoration that is not visible in the dress screenshot.
- Keep the background simple and consistent with the original character image; do not invent a new detailed scene.
- Do not add any text, watermarks, logos, extra people, or extra limbs.
- Output a single clean character illustration.`;

export function buildPrompt(npc: NpcConfig): string {
  return `${BASE_PROMPT}\n\nAbout this customer (${npc.name}): ${npc.promptNotes}`;
}
