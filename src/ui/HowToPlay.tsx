// UI LAYER — the how-to-play screen (presentation Session 4).
//
// A window over the board, opened from the setup screen or the HUD. It reads no
// match state at all — no view, no log, no player id — only the rule tables,
// through `./helpContent`. So there is nothing on it that could belong to one
// player rather than the other.
//
// **Mounted by `App` inside the board branch, never above the handoff `if`**
// (gotchas 58, 62). It is an overlay on the board, and the board is not there
// during a handoff; `App` also closes it when a handoff starts, so it does not
// reappear for the next player.
//
// While it is open it swallows Space, Enter and Escape in the capture phase, so
// closing it with Escape does not also skip the replay or dismiss a battle
// report underneath. The replay keeps playing behind it (designer's call).

import { useEffect, useRef } from 'react';
import { HOW_TO_PLAY, type HelpBlock } from './helpContent';
import { LEGEND, type LegendSwatch } from './legend';

interface Props {
  onClose: () => void;
}

export default function HowToPlay({ onClose }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
        // Space and Enter still work on whatever button has focus inside the
        // window; they just must not reach the replay or the battle report.
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  function jump(id: string) {
    const body = bodyRef.current;
    const target = body?.querySelector<HTMLElement>(`#help-${id}`);
    if (body && target) body.scrollTo({ top: target.offsetTop - body.offsetTop, behavior: 'smooth' });
  }

  return (
    <div className="help-scrim" onClick={onClose}>
      <div
        className="help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="help-head">
          <h1 id="help-title">How to play</h1>
          <button type="button" className="help-close" onClick={onClose} autoFocus>
            Close (Esc)
          </button>
        </header>

        <div className="help-main">
          <nav className="help-nav" aria-label="Sections">
            {HOW_TO_PLAY.map((section) => (
              <button key={section.id} type="button" onClick={() => jump(section.id)}>
                {section.title}
              </button>
            ))}
          </nav>

          <div className="help-body" ref={bodyRef}>
            {HOW_TO_PLAY.map((section) => (
              <section key={section.id} id={`help-${section.id}`}>
                <h2>{section.title}</h2>
                {section.blocks.map((block, i) => (
                  <Block key={i} block={block} />
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Block({ block }: { block: HelpBlock }) {
  switch (block.kind) {
    case 'p':
      return <p>{block.text}</p>;
    case 'list': {
      const items = block.items.map((item) => <li key={item}>{item}</li>);
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'legend':
      return (
        <ul className="help-legend">
          {LEGEND.map((entry) => (
            <li key={entry.text} className={entry.tone}>
              <Swatch swatch={entry.swatch} />
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      );
  }
}

/** A small picture of a board mark, drawn in its board colours. */
function Swatch({ swatch }: { swatch: LegendSwatch }) {
  const stroke = swatch.border ?? 'none';
  const fill = swatch.fill ?? 'none';
  return (
    <svg className="help-swatch" viewBox="-12 -12 24 24" aria-hidden="true">
      {swatch.shape === 'hex' && (
        <polygon
          points="-10,0 -5,-8.7 5,-8.7 10,0 5,8.7 -5,8.7"
          fill={fill}
          stroke={stroke}
          strokeWidth={2}
        />
      )}
      {swatch.shape === 'ring' && (
        <circle r={9} fill={fill} stroke={stroke} strokeWidth={2} />
      )}
      {swatch.shape === 'target' && (
        <g fill="none" stroke={stroke} strokeWidth={1.6}>
          <polygon points="-10,0 -5,-8.7 5,-8.7 10,0 5,8.7 -5,8.7" />
          <circle r={3.5} />
          <path d="M-6 0H6M0 -6V6" />
        </g>
      )}
      {swatch.glyph && (
        <text
          y={4}
          textAnchor="middle"
          fontSize={swatch.glyph.length > 1 ? 9 : 11}
          fontWeight={700}
          fill={swatch.fill && !swatch.fill.startsWith('rgba') ? '#0b0f14' : stroke}
        >
          {swatch.glyph}
        </text>
      )}
    </svg>
  );
}
