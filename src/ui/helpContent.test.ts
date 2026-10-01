import { describe, expect, it } from 'vitest';
import { RULES, SPAWNS, UNIT_DEFS } from '../sim/defs';
import { HOW_TO_PLAY, helpText } from './helpContent';
import { LEGEND } from './legend';

const all = helpText();
const joined = all.join('\n');

/** Split on sentence ends so a rule about "a sentence that says X" means it. */
function sentences(): string[] {
  return all.flatMap((text) => text.split(/(?<=[.!?:])\s+/));
}

describe('how-to-play: numbers come from the rule tables', () => {
  it('states the missile flight-time bands from missileSpeed and missileRange', () => {
    expect(joined).toContain(`Targets 1–${RULES.missileSpeed} hexes away are hit this round`);
    expect(joined).toContain(
      `Targets ${RULES.missileSpeed + 1}–${RULES.missileRange} hexes away take a round in the air and land next round`,
    );
  });

  it('states the round cap, launcher count, bunker hits and movement', () => {
    expect(joined).toContain(`after ${RULES.roundCap} rounds`);
    expect(joined).toContain(`all ${SPAWNS.p1.launchers.length} enemy launchers`);
    expect(joined).toContain(`land ${UNIT_DEFS.bunker.hp} hits on it`);
    expect(joined).toContain(`Move — up to ${UNIT_DEFS.launcher.movement} hexes`);
    expect(joined).toContain(`forced march of up to ${RULES.forcedMarchMovement} hexes`);
    expect(joined).toContain(`up to ${UNIT_DEFS.drone.movement} hexes, over anything`);
  });

  it('states interceptor cover, the per-round cap and the saturation count', () => {
    expect(joined).toContain(`every hex within ${RULES.interceptorCoverageRadius} of it`);
    expect(joined).toContain(`fire ${RULES.interceptsPerRound + 1} or more missiles`);
    expect(joined).toContain(`at least ${RULES.bunkerExclusionRadius} hexes from both`);
  });

  it('states that neither site may use the back row (§12)', () => {
    expect(joined).toMatch(/with neither site on the back (row|\d+ rows)\./);
  });

  it('types no number that is not derived: every digit in the copy is one of the rule values', () => {
    const allowed = new Set(
      [
        RULES.missileRange,
        RULES.missileSpeed,
        RULES.missileSpeed + 1,
        RULES.forcedMarchMovement,
        RULES.interceptorCoverageRadius,
        RULES.interceptsPerRound + 1,
        RULES.bunkerExclusionRadius,
        RULES.bunkerExclusionRadius - 1,
        RULES.roundCap,
        RULES.homeZoneRows.p1.max - RULES.homeZoneRows.p1.min + 1,
        RULES.siteBackRowsBarred,
        2 * RULES.reconSwathRadius + 1,
        SPAWNS.p1.launchers.length,
        UNIT_DEFS.launcher.movement,
        UNIT_DEFS.drone.movement,
        UNIT_DEFS.bunker.hp,
        UNIT_DEFS.bunker.hp - RULES.missileDamage,
        UNIT_DEFS.decoy.hp,
        RULES.missileDamage,
        1, // "1–4 hexes": the near end of a range is always 1
      ].map(String),
    );
    for (const n of joined.match(/\d+/g) ?? []) expect(allowed).toContain(n);
  });
});

describe('how-to-play: never promises what the rules do not give', () => {
  it('never says a warned missile can be dodged', () => {
    const dodgy = sentences().filter((s) =>
      /dodg|escape|get out of|out of the way|move away|run from|drive out/i.test(s),
    );
    expect(dodgy.length).toBeGreaterThan(0); // the screen does address it…
    for (const s of dodgy) {
      // …and only ever to say it cannot be done.
      expect(s).toMatch(/too late|cannot|can't|never/i);
    }
  });

  it('never suggests a bunker hit raises an alert, banner or warning', () => {
    for (const s of sentences()) {
      if (!/bunker/i.test(s) || !/\bhit/i.test(s)) continue;
      expect(s).not.toMatch(/alert|alarm|banner|notif|warn|popup|pop-up/i);
    }
  });

  it('never says the board or the drone can tell the real bunker from the decoy', () => {
    for (const s of sentences()) {
      expect(s).not.toMatch(/(drone|photo|recon|board) (shows|reveals|tells|marks) (the |which )?(real|decoy)/i);
    }
  });

  it('never talks about interceptor bases in the plural while each side has one', () => {
    if (RULES.placementCounts.interceptor !== 1) return;
    for (const s of sentences()) expect(s).not.toMatch(/\bbases\b/i);
  });

  it('cites no spec section numbers — this text is for players', () => {
    expect(joined).not.toMatch(/§/);
  });
});

describe('how-to-play: structure', () => {
  it('covers every topic the screen is for, once each', () => {
    const ids = HOW_TO_PLAY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['aim', 'round', 'orders', 'finding', 'missiles', 'endgame', 'board']) {
      expect(ids).toContain(id);
    }
  });

  it('prints the same legend lines as the HUD, not a copy', () => {
    for (const entry of LEGEND) expect(all).toContain(entry.text);
  });

  it('is a three-minute read', () => {
    const words = joined.split(/\s+/).length;
    expect(words).toBeLessThan(900);
  });
});
