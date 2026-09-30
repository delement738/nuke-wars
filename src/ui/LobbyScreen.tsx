// UI LAYER — the online waiting room (V1.5 Session 7).
//
// What a player sees between "I asked for a room" and "there are two of us":
// connecting, the room's code and link to send, and — if it goes wrong — why.
// It reads `online` only, never the board, so it has nothing to leak; and `App`
// shows it *instead of* the setup screen, so no board is drawn behind it.
//
// It styles itself with the handoff screen's plate (same opaque, centred card).

import { useState } from 'react';
import { roomLink } from '../net/config';
import { newMatch } from '../state/match';
import { useOnline } from '../state/useMatch';
import { ERROR_TEXT } from './onlineText';
import './hud.css';

interface Props {
  /** Back to the title screen — leaving the room. */
  onTitle: () => void;
}

export default function LobbyScreen({ onTitle }: Props) {
  const online = useOnline();
  const [copied, setCopied] = useState(false);
  if (!online) return null;

  const link = online.room ? roomLink(online.room) : null;

  function copy() {
    if (!link) return;
    void navigator.clipboard?.writeText(link).then(() => setCopied(true));
  }

  function leave() {
    newMatch(Date.now() % 100000);
    onTitle();
  }

  // Why we are not in a match: an ending first, then a wait, then the invite.
  let body;
  if (online.error) {
    body = <p className="alert">{ERROR_TEXT[online.error]}</p>;
  } else if (online.status === 'closed') {
    body = <p className="alert">Lost the connection to the server.</p>;
  } else if (online.status === 'reconnecting') {
    body = <p className="alert">Connection lost. Trying to get back in…</p>;
  } else if (online.status === 'connecting' || !link) {
    body = <p className="muted">Contacting the command post…</p>;
  } else {
    body = (
      <>
        <p className="muted">Your room is open. Send your opponent this link:</p>
        <p className="handoff-to lobby-code">{online.room}</p>
        <p className="footnote lobby-link">{link}</p>
        <div className="buttons">
          <button type="button" onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <p className="alert lobby-waiting">Waiting for your opponent to join…</p>
      </>
    );
  }

  return (
    <div className="handoff">
      <section className="panel handoff-card lobby-card">
        <h2>Online match</h2>
        {body}
        <div className="buttons">
          <button type="button" onClick={leave}>
            {online.error || online.status === 'closed' ? 'Back to title' : 'Leave'}
          </button>
        </div>
      </section>
    </div>
  );
}
