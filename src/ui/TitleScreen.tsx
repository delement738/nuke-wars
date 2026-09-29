// UI LAYER — the title screen (V1.5 Session 2, identity).
//
// The first thing a visitor sees: the name, the tagline and three ways in, over
// a war map that never stops sliding past (`./titleBackdrop`). Style is set out
// in `docs/art-direction.md`.
//
// **It is presentation state, not a match stage** (gotcha 42). The store knows
// nothing about it: `App` holds a flag and swaps this in for the board before a
// match exists. The two play buttons call the very `setSeating` the setup panel
// uses, then hand over to that panel, where difficulty and placement still live.
//
// Enter starts a game against the CPU, as the reference art's "press Enter"
// promises. The how-to-play window swallows Enter in the capture phase while it
// is open, so Enter there never reaches this listener.
//
// Phones get a notice instead of the buttons (designer's ruling: desktop and
// tablet only), with a way past it for anyone who wants to try anyway.

import { useEffect, useState, type CSSProperties } from 'react';
import { DRIFT_PERIOD_S, TILE_H, TILE_W, titleTileCss } from './titleBackdrop';
import './title.css';

export type PlayMode = 'solo' | 'hotseat';

interface Props {
  onPlay: (mode: PlayMode) => void;
  onHelp: () => void;
}

/** The map tile, built once: it never changes. */
const TILE = titleTileCss();

/** Narrower than this and the board cannot be played comfortably. */
const PHONE_QUERY = '(max-width: 700px)';

function isPhone(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches === true;
}

export default function TitleScreen({ onPlay, onHelp }: Props) {
  const [phone, setPhone] = useState(isPhone);
  const [anyway, setAnyway] = useState(false);

  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const update = () => setPhone(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const blocked = phone && !anyway;

  useEffect(() => {
    if (blocked) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Enter' || event.repeat) return;
      // A focused button already answers Enter itself.
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      onPlay('solo');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blocked, onPlay]);

  return (
    <div className="title">
      <div
        className="title-drift"
        aria-hidden="true"
        style={
          {
            backgroundImage: TILE,
            '--tile-w': `${TILE_W}px`,
            '--tile-h': `${TILE_H}px`,
            '--drift-period': `${DRIFT_PERIOD_S}s`,
          } as CSSProperties
        }
      />
      <div className="title-lamp" aria-hidden="true" />

      <main className="title-card">
        <div className="title-plate">
          <h1 className="title-name">Nuke Wars</h1>
          <p className="title-tagline">Disarm or decapitate the enemy regime</p>
        </div>

        {blocked ? (
          <div className="title-notice" role="note">
            <p>
              Nuke Wars is built for a desktop or tablet screen. On a phone the
              map is too small to play properly.
            </p>
            <button type="button" className="title-link" onClick={() => setAnyway(true)}>
              Continue anyway
            </button>
          </div>
        ) : (
          <div className="title-console">
            <div className="title-rule">
              <span>Strategic assets deployed</span>
            </div>
            <nav className="title-menu">
              <button type="button" className="title-btn primary" onClick={() => onPlay('solo')}>
                Play vs CPU
              </button>
              <button type="button" className="title-btn" onClick={() => onPlay('hotseat')}>
                Two players (hotseat)
              </button>
              <button type="button" className="title-btn" onClick={() => onHelp()}>
                How to play
              </button>
            </nav>
            <p className="title-press">Press Enter to begin campaign</p>
          </div>
        )}
      </main>
    </div>
  );
}
