// UI LAYER — the online match's room and connection (V1.5 Session 6).
//
// Deliberately bare: the room link to send your opponent, whether they are
// here, and what went wrong if something did. Session 7 replaces this with the
// real lobby and waiting screens. It reads `online` only — nothing about the
// board — so it has nothing to leak.

import { useState } from 'react';
import { roomLink } from '../net/config';
import type { ErrorCode } from '../net/protocol';
import { newMatch } from '../state/match';
import { useOnline } from '../state/useMatch';

/** What each refusal means, in the player's terms. */
const ERROR_TEXT: Record<ErrorCode, string> = {
  BAD_MESSAGE: 'The server did not understand this browser. Try reloading the page.',
  VERSION_MISMATCH: 'This page is out of date with the server. Reload the page to update it.',
  NO_SUCH_ROOM: 'That room does not exist, or has closed.',
  ROOM_FULL: 'That room already has two players.',
  NOT_IN_ROOM: 'Not in a room yet.',
  ALREADY_IN_ROOM: 'Already in a room.',
  ILLEGAL_SETUP: 'The server refused that setup. Move something and try again.',
};

export default function OnlinePanel() {
  const online = useOnline();
  const [copied, setCopied] = useState(false);
  if (!online) return null;

  const link = online.room ? roomLink(online.room) : null;

  function copy() {
    if (!link) return;
    void navigator.clipboard?.writeText(link).then(() => setCopied(true));
  }

  return (
    <section className="panel">
      <h2>Online match</h2>

      {online.status === 'connecting' && <p className="muted">Connecting to the server…</p>}
      {online.status === 'closed' && (
        <p className="alert">Lost the connection to the server. This match cannot continue.</p>
      )}
      {online.error && <p className="alert">{ERROR_TEXT[online.error]}</p>}

      {online.status === 'open' && link && (
        <>
          <p className="muted">
            Room <strong>{online.room}</strong>. You are {online.seat?.toUpperCase()}.
          </p>
          {!online.opponentPresent && online.opponentJoined && (
            <p className="alert">Your opponent has disconnected.</p>
          )}
          {!online.opponentJoined && (
            <>
              <p className="alert">Waiting for your opponent. Send them this link:</p>
              <p className="footnote">{link}</p>
              <div className="buttons">
                <button type="button" onClick={copy}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </>
          )}
          {online.opponentPresent && <p className="muted">Opponent connected.</p>}
        </>
      )}

      <div className="buttons">
        <button type="button" onClick={() => newMatch(Date.now() % 100000)}>
          Leave
        </button>
      </div>
    </section>
  );
}
