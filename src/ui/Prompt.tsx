// UI LAYER — the "what do I click now?" card (2026-10-03).
//
// Reads nothing and sends nothing: it only lays out the words it is given. Every
// instruction that tells the player what to click next uses this card, so they
// all look alike — a short headline that says what to do, one plain line of
// detail, and a little hex in the same colour as the highlight on the board.
// That swatch is the point: "click a green hex" is easier to follow when the
// card itself shows the green.
//
// The colour comes from `src/render/palette.ts`, the table the board draws its
// highlights with, so the swatch can never drift from the hexes it names.

import type { CSSProperties, ReactNode } from 'react';
import { css, type PaletteName } from '../render/palette';

interface Props {
  /** The board highlight this prompt is about, or 'warning' for danger. */
  tone: PaletteName | 'warning';
  /** What to do, in a few words: "Fire — pick a target". */
  title: string;
  /** One line of detail under the headline. */
  children?: ReactNode;
}

/** Danger isn't a board highlight, so it has its own colour (the enemy red). */
const WARNING = css('enemy');

export default function Prompt({ tone, title, children }: Props) {
  const colour = tone === 'warning' ? WARNING : css(tone);
  return (
    <div
      className="prompt"
      role="status"
      style={{ '--tone': colour } as CSSProperties}
    >
      <span className="prompt-swatch" aria-hidden="true" />
      <div className="prompt-text">
        <p className="prompt-title">{title}</p>
        {children && <p className="prompt-body">{children}</p>}
      </div>
    </div>
  );
}
