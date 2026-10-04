// UI LAYER — the stat tab in the top-right corner (2026-10-03).
//
// Reads state, sends no intents. Collapsed, it is one strip: launchers alive,
// command bunker hits left, decoy standing or not, and the kill counter. Click
// it to open the details: each of your assets, and every confirmed kill.
//
// **During a replay it shows the board from BEFORE the round**, like the event
// log, which holds the round back until its replay ends. Otherwise the counter
// would tick before the missile on screen had landed and spoil the outcome.

import { useState } from 'react';
import type { UnitKind } from '../sim/types';
import { useLog, useReplay, useView, useViewer } from '../state/useMatch';
import { hexLabel } from './eventText';
import { confirmedKills, tallyAssets } from './stats';

const KIND_NAME: Record<UnitKind, string> = {
  launcher: 'Launcher',
  drone: 'Drone',
  bunker: 'Command bunker',
  decoy: 'Decoy bunker',
  interceptor: 'Interceptor base',
};

/** A row of little blocks: `filled` lit out of `total`. */
function Pips({ filled, total }: { filled: number; total: number }) {
  return (
    <span className="pips" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < filled ? 'pip lit' : 'pip'} />
      ))}
    </span>
  );
}

export default function StatTab() {
  const [open, setOpen] = useState(false);
  const view = useView();
  const viewer = useViewer();
  const replay = useReplay();
  const fullLog = useLog();

  if (!view) return null;

  // Before the round being replayed, exactly as the board and log show it.
  const board = replay ? replay.from : view;
  const log = replay ? fullLog.filter((entry) => entry.round !== replay.round) : fullLog;

  const assets = tallyAssets(board.units, viewer);
  const kills = confirmedKills(log, view.units, viewer);
  const { launchers, bunker } = assets;

  const summary =
    `${launchers.alive} of ${launchers.total} launchers, ` +
    `bunker ${bunker.hp} of ${bunker.max} hits, ` +
    `decoy ${assets.decoyAlive ? 'standing' : 'destroyed'}, ` +
    `${kills.length} kill${kills.length === 1 ? '' : 's'}`;

  return (
    <section className={open ? 'panel stat-tab open' : 'panel stat-tab'}>
      <button
        type="button"
        className="stat-strip"
        aria-expanded={open}
        aria-label={`Status: ${summary}. ${open ? 'Hide' : 'Show'} details.`}
        title={open ? 'Hide details' : 'Show your assets and confirmed kills'}
        onClick={() => setOpen(!open)}
      >
        <span className="stat">
          <span className="stat-label">Launchers</span>
          <Pips filled={launchers.alive} total={launchers.total} />
        </span>
        <span className="stat">
          <span className="stat-label">Bunker</span>
          <Pips filled={bunker.hp} total={bunker.max} />
        </span>
        <span className="stat">
          <span className="stat-label">Decoy</span>
          <Pips filled={assets.decoyAlive ? 1 : 0} total={1} />
        </span>
        <span className="stat kills">
          <span className="stat-label">Kills</span>
          <span className="stat-number">{kills.length}</span>
        </span>
        <span className="stat-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="stat-details">
          <h3>Your assets</h3>
          <dl className="stat-list">
            <dt>Launchers</dt>
            <dd>{launchers.alive} of {launchers.total} alive</dd>

            <dt>Command bunker</dt>
            <dd className={bunker.hp < bunker.max ? 'warn' : undefined}>
              {bunker.hp === 0
                ? 'destroyed'
                : bunker.hp === bunker.max
                  ? `full health (${bunker.hp} of ${bunker.max} hits)`
                  : `damaged — ${bunker.hp} of ${bunker.max} hits left`}
            </dd>

            <dt>Decoy bunker</dt>
            <dd className={assets.decoyAlive ? undefined : 'warn'}>
              {assets.decoyAlive ? 'standing' : 'destroyed'}
            </dd>

            <dt>Interceptor base</dt>
            <dd className={assets.baseAlive ? undefined : 'warn'}>
              {assets.baseAlive ? 'standing' : 'destroyed'}
            </dd>

            <dt>Drone</dt>
            <dd>
              {board.droneRespawnIn > 0
                ? `down — back in ${board.droneRespawnIn} round${board.droneRespawnIn === 1 ? '' : 's'}`
                : 'on station'}
            </dd>
          </dl>

          <h3>Confirmed kills ({kills.length})</h3>
          {kills.length === 0 ? (
            <p className="muted">None yet. A kill counts once it is in your log.</p>
          ) : (
            <ol className="kill-list">
              {[...kills].reverse().map((kill, i) => (
                <li key={i}>
                  <span className="enemy">{KIND_NAME[kill.kind]}</span>
                  <span className="kill-where">
                    R{kill.round} · {hexLabel(kill.hex)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="footnote">
            Damage that doesn’t kill is never confirmed — a hit on their bunker
            looks just like a miss.
          </p>
        </div>
      )}
    </section>
  );
}
