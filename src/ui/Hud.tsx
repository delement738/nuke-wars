// UI LAYER — the HUD (build-order step 9).
//
// Reads state, sends player intents, never mutates game state. Every number on
// screen comes from the current viewer's `VisibleGameState`; every button calls
// an action in `src/state/match.ts`. There is no third path.
//
// The human side now gives real orders (build-order step 10a): `OrderPanel`
// drafts them and `resolveRound()` submits them. "Resolve round" stays as the
// way to go early — undecided units simply hold, which is a legal round on its
// own (§3) — but a draft that decides every orderable unit resolves itself
// without it. The CPU side (SANDBOX_DUMMY) is decided by `src/state/cpu.ts`
// from its own redacted view, same as any player.
//
// Both players' assets are now really placed before the match: the human's on
// `SetupPanel`'s screen (session 10b), the CPU's by the same fixture that backs
// Auto-place. `App` mounts this component only once that has happened, which is
// why the board it reads is never null in practice.
//
// **Only things you can do in this match live here** (designer's call,
// 2026-09-28): the round's status and its two commitments (resolve / resign),
// your orders, and what you have selected. Choosing the kind of game — seating,
// CPU difficulty, the map — happens on the setup screen before a match exists,
// and the legend is one click away behind `?` in How to play. The sandbox's
// "view as P2" switch went with them; `setViewer` stays in the store for tests.

import { opponentOf } from '../sim/types';
import { endTurn, finishReplay, newMatch, resign } from '../state/match';
import {
  useFinalReveal,
  useIsHotseat,
  useReplay,
  useView,
  useViewer,
} from '../state/useMatch';
import EventLog from './EventLog';
import HelpButton from './HelpButton';
import OrderPanel from './OrderPanel';
import SelectionPanel from './SelectionPanel';
import { describeOutcome } from './eventText';
import './hud.css';

interface Props {
  /** Opens the how-to-play window, which `App` owns, optionally at a section. */
  onHelp: (section?: string) => void;
}

export default function Hud({ onHelp }: Props) {
  const view = useView();
  const viewer = useViewer();
  const hotseat = useIsHotseat();
  const replay = useReplay();
  const reveal = useFinalReveal();

  // `App` only mounts this once a match exists, so a null view is unreachable —
  // but `useView()` is nullable because the setup screen legitimately has no
  // board (step 10b), and narrowing it here is cheaper than a second source of
  // truth about which screen we are on.
  if (!view) return null;

  const over = view.outcome !== null;
  const deadHand = view.phase === 'DEAD_HAND_PHASE';

  return (
    <div className="hud">
      <div className="column left">
        {/* While the viewer's replay plays, the board is last round's picture,
            so the order controls and the new round's status would be talking
            about a board that is not on screen (and would spoil the outcome).
            They come back the moment the replay ends or is skipped. */}
        {replay ? (
          <section className="panel">
            <h2>
              Replaying round {replay.round}
              <span className="head-right">
                <span className="viewing">viewing {viewer.toUpperCase()}</span>
                <HelpButton onClick={() => onHelp('board')} />
              </span>
            </h2>
            <p className="muted">
              Watch what happened, then give your orders. The log fills in when
              the replay ends.
            </p>
            <div className="buttons">
              <button type="button" onClick={() => finishReplay()}>
                Skip replay (Space)
              </button>
            </div>
          </section>
        ) : (
        <>
        <section className="panel">
          <h2>
            Round {view.round}
            <span className="head-right">
              <span className="viewing">viewing {viewer.toUpperCase()}</span>
              <HelpButton onClick={() => onHelp('board')} />
            </span>
          </h2>

          <p className={deadHand ? 'alert' : 'muted'}>
            {over
              ? 'Match over.'
              : deadHand
                ? view.deadHandFor === viewer
                  ? 'DEAD HAND — your final volley. Launches only.'
                  : 'DEAD HAND — the enemy fires a final volley.'
                : 'Order phase.'}
          </p>

          {view.outcome && (
            <p className="outcome">{describeOutcome(view.outcome, viewer)}</p>
          )}

          {reveal && (
            <p className="muted">
              Enemy positions revealed: every enemy piece is on the board in red,
              where it really was.
            </p>
          )}

          <p className="muted">
            {view.droneRespawnIn > 0
              ? `Drone down — returns in ${view.droneRespawnIn} round${view.droneRespawnIn === 1 ? '' : 's'}.`
              : 'Drone on station.'}
          </p>

          <div className="buttons">
            <button type="button" onClick={() => endTurn()} disabled={over}>
              {/* In hotseat this ends YOUR turn and passes the screen; only the
                  second player's turn ending resolves the round, which is what
                  keeps orders simultaneous (§3). */}
              {hotseat
                ? `Done — pass to ${opponentOf(viewer).toUpperCase()}`
                : deadHand
                  ? 'Resolve final volley'
                  : 'Resolve round'}
            </button>
            <button type="button" onClick={() => resign(viewer)} disabled={over}>
              Resign
            </button>
          </div>

          {/* The one way out of a finished match: back to the setup screen,
              where the next game's seating, difficulty and map are chosen. */}
          {over && (
            <div className="buttons">
              <button type="button" onClick={() => newMatch(Date.now() % 100000)}>
                New game
              </button>
            </div>
          )}

          <p className="footnote">
            Finishing early is legal: any unit you have not decided holds, and a
            drone with no order hovers and watches its own corridor.
          </p>
        </section>

        <OrderPanel />

        <SelectionPanel />
        </>
        )}
      </div>

      <div className="column right">
        <EventLog />
      </div>
    </div>
  );
}
