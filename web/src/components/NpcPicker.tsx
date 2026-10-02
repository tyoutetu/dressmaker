import type { CSSProperties } from "react";
import { ENABLED_NPCS, type NpcConfig } from "../npcs";
import { assetUrl } from "../lib/assets";
import { IconCheck } from "./Icons";

interface Props {
  selectedId: string | null;
  onSelect: (npc: NpcConfig) => void;
  disabled: boolean;
}

/**
 * Native radio inputs styled as customer cards: arrow keys, grouping and the
 * checked state all come from the platform, and each portrait is framed from the
 * full supplied image instead of a cropped avatar tile.
 */
export function NpcPicker({ selectedId, onSelect, disabled }: Props) {
  return (
    <fieldset className="npc-fieldset" disabled={disabled}>
      <legend className="visually-hidden">Which customer should wear your dress?</legend>
      <div className="npc-grid">
        {ENABLED_NPCS.map((npc) => {
          const isSelected = selectedId === npc.id;
          return (
            <label
              key={npc.id}
              className={`npc-card${isSelected ? " is-selected" : ""}`}
              data-customer={npc.id}
            >
              <input
                className="npc-radio"
                type="radio"
                name="customer"
                value={npc.id}
                aria-label={npc.name}
                checked={isSelected}
                onChange={() => onSelect(npc)}
              />
              <span className="npc-portrait" style={portraitStyle(npc)}>
                <img
                  src={assetUrl(npc.displayImage)}
                  alt=""
                  width={1024}
                  height={1024}
                  decoding="async"
                />
              </span>
              <span className="npc-foot">
                <span className="npc-name">{npc.name}</span>
                <span className={`npc-flag${isSelected ? " is-on" : ""}`}>
                  {isSelected && <IconCheck width={15} height={15} strokeWidth={2.4} />}
                  {isSelected ? "Selected" : "Choose"}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * The supplied art is a 1024x1024 canvas with transparent margins. These values
 * (measured from each file's alpha bounding box) scale and nudge the whole
 * figure so it fills the frame without cropping anything — the bitmaps
 * themselves are untouched.
 */
function portraitStyle(npc: NpcConfig): CSSProperties {
  return {
    "--portrait-scale": String(npc.portrait.scale),
    "--portrait-x": `${npc.portrait.x}%`,
    "--portrait-y": `${npc.portrait.y}%`,
  } as CSSProperties;
}
