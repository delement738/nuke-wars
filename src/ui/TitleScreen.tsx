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
// Below the menu, when there is a server: a box to join a friend's game by its
// six-character room code (or a pasted invite link), for anyone who was told the
// code rather than sent the link.
//
// Phones get a notice instead of the buttons (designer's ruling: desktop and
// tablet only), with a way past it for anyone who wants to try anyway.

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { SERVER_URL } from '../net/config';
import { ROOM_CODE_LENGTH, readRoomCode } from '../net/protocol';
import SoundButton from './SoundButton';
import { DRIFT_PERIOD_S, TILE_H, TILE_W, titleTileCss } from './titleBackdrop';
import './title.css';

export type PlayMode = 'solo' | 'hotseat' | 'online';

interface Props {
  /** `room`: join that room (online only) instead of opening a new one. */
  onPlay: (mode: PlayMode, room?: string) => void;
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
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(false);

  function join(event: FormEvent) {
    event.preventDefault();
    const room = readRoomCode(code);
    if (room) onPlay('online', room);
    else setCodeError(true);
  }

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
      <SoundButton className="sound-corner" />

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
              {/* Only when there is a server to talk to (V1.5 Session 6; "(test)" dropped from the label in Session 9):
                  in development, or once Session 8 configures one. */}
              {SERVER_URL && (
                <button type="button" className="title-btn" onClick={() => onPlay('online')}>
                  Play online
                </button>
              )}
              <button type="button" className="title-btn" onClick={() => onHelp()}>
                How to play
              </button>
            </nav>
            {SERVER_URL && (
              <form className="title-join" onSubmit={join}>
                <label htmlFor="title-join-code">Have a code? Join a friend's game</label>
                <div className="title-join-row">
                  <input
                    id="title-join-code"
                    className="title-join-input"
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value);
                      setCodeError(false);
                    }}
                    placeholder="e.g. U7EK44"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    aria-invalid={codeError}
                    aria-describedby={codeError ? 'title-join-error' : undefined}
                  />
                  <button type="submit" className="title-btn primary title-join-btn">
                    Join
                  </button>
                </div>
                {codeError && (
                  <p id="title-join-error" className="title-join-error" role="alert">
                    A room code is {ROOM_CODE_LENGTH} letters and numbers, like U7EK44.
                  </p>
                )}
              </form>
            )}
            <p className="title-press">Press Enter to begin campaign</p>
          </div>
        )}
      </main>
    </div>
  );
}
