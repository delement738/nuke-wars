// UI LAYER — the running event log (build-order step 9).
//
// Reads state, sends no intents. This is spec §11's "permanent history, not live
// intel": map markers expire on the §11 schedule, log entries never do, so every
// launch this player has detected stays readable here for the whole match.
//
// Newest round first, and chronological *within* a round. The order inside a
// round is the engine's canonical emission order (§6 — recon, launches,
// impacts, movement), which is also the order a client would animate it in, so
// the log reads as a narrative of the round rather than a set of facts.

import { useLog, useView, useViewer } from '../state/useMatch';
import type { LogEntry } from '../state/match';
import { describeEvent } from './eventText';

export default function EventLog() {
  const log = useLog();
  const viewer = useViewer();
  const view = useView();

  const rounds = groupByRound(log);

  return (
    <section className="panel log">
      <h2>Event log</h2>

      {rounds.length === 0 ? (
        <p className="muted">Nothing detected yet. Resolve a round.</p>
      ) : (
        <ol className="rounds">
          {rounds.map(([round, entries]) => (
            <li key={round}>
              <h3>Round {round}</h3>
              <ul>
                {entries.map((entry, i) => (
                  <li key={i}>{describeEvent(entry.event, viewer, view.units)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Entries bucketed by round, newest round first, order preserved inside. */
function groupByRound(log: readonly LogEntry[]): [number, LogEntry[]][] {
  const rounds = new Map<number, LogEntry[]>();

  for (const entry of log) {
    const bucket = rounds.get(entry.round);
    if (bucket) bucket.push(entry);
    else rounds.set(entry.round, [entry]);
  }

  return [...rounds.entries()].reverse();
}
