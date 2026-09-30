// UI LAYER — the online match's room and connection (V1.5 Sessions 6–7).
//
// Once two players are in: the room, who is who, and whether the other side is
// still there. (The invite link and the waiting for a second player are the
// waiting room's, `LobbyScreen`.) It reads `online` only — nothing about the
// board — so it has nothing to leak.

import { newMatch } from '../state/match';
import { useOnline } from '../state/useMatch';
import { ERROR_TEXT } from './onlineText';

export default function OnlinePanel() {
  const online = useOnline();
  if (!online) return null;

  return (
    <section className="panel">
      <h2>Online match</h2>

      {online.status === 'reconnecting' && (
        <p className="alert">Connection lost — trying to get back in. Your seat is held.</p>
      )}
      {online.status === 'closed' && (
        <p className="alert">Lost the connection to the server. This match cannot continue.</p>
      )}
      {online.error && <p className="alert">{ERROR_TEXT[online.error]}</p>}

      {online.status === 'open' && (
        <>
          <p className="muted">
            Room <strong>{online.room}</strong>. You are {online.seat?.toUpperCase()}.
          </p>
          {online.opponentPresent ? (
            <p className="muted">Opponent connected.</p>
          ) : (
            <p className="alert">
              Your opponent has disconnected. If they do not return, their orders
              are sent empty when the clock runs out.
            </p>
          )}
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
