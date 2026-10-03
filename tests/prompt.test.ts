import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildPrompt, NEGATIVE_PROMPT } from "../lib/prompt";
import { ENABLED_NPCS } from "../lib/npcs";

/**
 * A live spike showed the model keeping the customer's own long sleeves under
 * sleeveless and short-sleeved dresses — it read "keep the character's identity"
 * as covering her wardrobe. The prompt is the only lever against that, so these
 * assertions pin the clauses that were added to fix it. They cannot prove the
 * model obeys; they only stop the wording from being silently weakened later.
 */

describe("generation prompt", () => {
  const prompt = buildPrompt(ENABLED_NPCS[0]);

  test("scopes identity to the person, not her clothes", () => {
    assert.match(prompt, /Identity means the PERSON/i);
  });

  test("demands a complete clothing replacement, not a change of outer layer", () => {
    assert.match(prompt, /Replace her clothing COMPLETELY/i);
    assert.match(prompt, /not the top, not the skirt, not the collar/i);
    assert.match(prompt, /do not place the new dress over the old one/i);
  });

  test("forbids inventing or retaining sleeves", () => {
    assert.match(prompt, /If that dress is sleeveless or strapless/i);
    assert.match(prompt, /never add sleeves that are not in the second image/i);
    assert.match(prompt, /never keep her original sleeves showing beneath/i);
  });

  test("still asks for the dress details that were already working", () => {
    for (const detail of ["silhouette", "color blocking", "pattern or print", "neckline", "hemline", "bows, lace, ribbons and trims"]) {
      assert.ok(prompt.includes(detail), `prompt must still mention "${detail}"`);
    }
  });

  test("keeps the safety and framing clauses", () => {
    assert.match(prompt, /Do not add any text, watermarks, logos, extra people, or extra limbs/i);
    assert.match(prompt, /single clean character illustration/i);
  });

  test("appends the per-customer notes so every customer keeps their own identity", () => {
    for (const npc of ENABLED_NPCS) {
      const text = buildPrompt(npc);
      assert.ok(text.includes(npc.name), `${npc.id} prompt names the customer`);
      assert.ok(text.includes(npc.promptNotes), `${npc.id} prompt carries its notes`);
    }
  });
});

describe("negative prompt", () => {
  test("targets layering, not sleeves", () => {
    // A blanket "long sleeves" negative would wreck the dresses that genuinely
    // have them — two of the five test dresses do — so the wording has to name
    // the behaviour (wearing two garments at once) instead of the garment.
    assert.match(NEGATIVE_PROMPT, /layered clothing/i);
    assert.match(NEGATIVE_PROMPT, /two outfits worn at once/i);
    assert.match(NEGATIVE_PROMPT, /underneath the dress/i);
    assert.ok(
      !/\blong sleeves\b/i.test(NEGATIVE_PROMPT),
      "must not ban long sleeves outright",
    );
  });

  test("is a non-empty, comma-separated phrase list", () => {
    assert.ok(NEGATIVE_PROMPT.trim().length > 0);
    const phrases = NEGATIVE_PROMPT.split(",").map((p) => p.trim());
    assert.ok(phrases.length >= 4, "several distinct phrases");
    assert.ok(phrases.every((p) => p.length > 0), "no empty phrase");
  });
});
