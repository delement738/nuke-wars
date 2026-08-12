// UI LAYER — what is on the hex the player clicked (build-order step 9).
//
// Reads state, sends no intents. Everything it can say comes out of a
// `VisibleGameState`, which is the whole reason this panel is safe to write:
// there is no enemy unit in that type to accidentally describe. Clicking an
// enemy-held hex the player has not detected reports bare terrain, exactly as it
// should — the map is public, the assets on it are not (spec §11).

import { UNIT_DEFS } from '../sim/defs';
import { axialToOffset, hexKey } from '../sim/hex';
import { tileAt, type Terrain } from '../sim/map';
import { useSelected, useView } from '../state/useMatch';
import { hexLabel } from './eventText';

export default function SelectionPanel() {
  const view = useView();
  const selected = useSelected();

  if (!selected) {
    return (
      <section className="panel">
        <h2>Hex</h2>
        <p className="muted">Click a tile to inspect it.</p>
      </section>
    );
  }

  const key = hexKey(selected);
  const tile = tileAt(view.map, axialToOffset(selected));
  const own = view.units.filter((unit) => hexKey(unit.position) === key);
  const reveal = view.intel.staticReveals.find((r) => hexKey(r.hex) === key);
  const contact = view.intel.contacts.find((c) => hexKey(c.hex) === key);

  return (
    <section className="panel">
      <h2>Hex {hexLabel(selected)}</h2>

      <p>{tile ? terrainLine(tile.terrain) : 'Off the map.'}</p>

      {own.map((unit) => (
        <p key={unit.id} className="own">
          Your {unit.kind}
          {unit.destroyed
            ? ' — destroyed'
            : UNIT_DEFS[unit.kind].hp > 1
              ? ` — ${unit.hp} of ${UNIT_DEFS[unit.kind].hp} hits left`
              : ''}
        </p>
      ))}

      {reveal && (
        <p className="enemy">
          Enemy {reveal.kind === 'bunker' ? 'bunker site' : 'interceptor base'} —
          spotted round {reveal.round}, permanent.
        </p>
      )}

      {contact && (
        <p className="enemy">
          Enemy launcher —{' '}
          {contact.source === 'LAUNCH'
            ? 'fired from here last round. It could not also have moved.'
            : 'photographed here by recon. It may have moved since.'}
          {' '}Expires when this round resolves.
        </p>
      )}

      {own.length === 0 && !reveal && !contact && (
        <p className="muted">Nothing you can see.</p>
      )}
    </section>
  );
}

function terrainLine(terrain: Terrain): string {
  // Not "impassable": mountains block *movement* only. A bunker, decoy or
  // interceptor base may be built on one, and missiles and drones cross it
  // freely (spec §2, §12 — CLAUDE.md gotcha 7b).
  return terrain === 'mountain'
    ? 'Mountain — no ground unit may enter. Structures may be built here.'
    : 'Plains — open ground.';
}
