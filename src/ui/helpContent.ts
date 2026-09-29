// UI LAYER — the words on the how-to-play screen (presentation Session 4).
//
// Plain data, no React, so a test can read every sentence the player will read.
// Two rules govern this file:
//
//   1. **Every number comes from `src/sim/defs.ts`.** Nothing here types a 6 or
//      a 25; a balance pass that edits `RULES` rewrites this screen with it.
//   2. **Never promise what the rules do not give** (gotchas 60, 69, 70). The
//      two that are easy to get wrong in friendly prose, and that
//      `helpContent.test.ts` guards: a warned missile can NOT be dodged (it lands
//      before anyone moves), and a hit on the real bunker raises no alarm
//      anywhere — the attacker's silence is the whole decoy test.
//
// No spec section numbers: this is written for players, not for the codebase.

import { RULES, SPAWNS, UNIT_DEFS } from '../sim/defs';
import { LEGEND } from './legend';

export type HelpBlock =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: readonly string[]; ordered?: boolean }
  | { kind: 'legend' };

export interface HelpSection {
  id: string;
  title: string;
  blocks: readonly HelpBlock[];
}

const p = (text: string): HelpBlock => ({ kind: 'p', text });
const list = (items: readonly string[], ordered = false): HelpBlock => ({
  kind: 'list',
  items,
  ordered,
});

/** "one interceptor base" / "2 interceptor bases" — the roster decides. */
function count(n: number, noun: string): string {
  return n === 1 ? `one ${noun}` : `${n} ${noun}s`;
}

/** "1 hit" / "2 hits". */
function hits(n: number): string {
  return n === 1 ? '1 hit' : `${n} hits`;
}

/** When a downed drone is back, from `droneRespawnDelay`. */
function respawnText(delay: number): string {
  return delay <= 1
    ? 'You get a new drone the very next round.'
    : `You get a new drone ${delay} rounds later.`;
}

/**
 * "The drone can never photograph a base" is true only while the swath is no
 * wider than the base's cover (gotcha 20). Printed only while it holds, so a
 * radius change cannot leave the screen promising something false.
 */
const BASES_UNPHOTOGRAPHABLE =
  RULES.reconSwathRadius <= RULES.interceptorCoverageRadius;

const LAUNCHERS = SPAWNS.p1.launchers.length;
const BASES = RULES.placementCounts.interceptor;
const BASE = count(BASES, 'interceptor base');
const BUNKER_HP = UNIT_DEFS.bunker.hp;
const DECOY_HP = UNIT_DEFS.decoy.hp;
const RANGE = RULES.missileRange;
const SPEED = RULES.missileSpeed;
const MOVE = UNIT_DEFS.launcher.movement;
const MARCH = RULES.forcedMarchMovement;
const FLIGHT = UNIT_DEFS.drone.movement;
const SWATH = 2 * RULES.reconSwathRadius + 1;
const COVER = RULES.interceptorCoverageRadius;
const STOPS = RULES.interceptsPerRound;
const SATURATE = STOPS + 1;
const EXCLUSION = RULES.bunkerExclusionRadius;
const ZONE_ROWS = RULES.homeZoneRows.p1.max - RULES.homeZoneRows.p1.min + 1;
const DAMAGE = RULES.missileDamage;

/** The whole screen, top to bottom. */
export const HOW_TO_PLAY: readonly HelpSection[] = [
  {
    id: 'aim',
    title: 'The aim',
    blocks: [
      p(`Each side hides a command bunker and a decoy. Find the enemy's real bunker, land ${hits(BUNKER_HP)} on it, and survive their last volley to win.`),
      p(`The decoy looks exactly like the real bunker, dies to ${hits(DECOY_HP)}, and destroying it wins nothing.`),
      p(`You also win by destroying all ${LAUNCHERS} enemy launchers. If both bunkers fall, or both sides lose their last launcher in the same round, it is a draw. No winner after ${RULES.roundCap} rounds is a draw too.`),
    ],
  },
  {
    id: 'setup',
    title: 'Before the match',
    blocks: [
      p(`Hide your bunker, decoy and ${BASE} in the ${ZONE_ROWS} gold rows at your end. Neither player sees the other's. Launchers and drones start on fixed, known hexes.`),
      p(`The base must be at least ${EXCLUSION} hexes from both sites, so it guards an approach, never the bunker. Keep the sites apart: one drone pass photographs a strip ${SWATH} hexes wide.`),
    ],
  },
  {
    id: 'round',
    title: 'A round',
    blocks: [
      p("Both players give orders at the same time, without seeing each other's. Then the round plays out in this order:"),
      list(
        [
          'Drones fly and take photos.',
          "Missiles fly; each side's interceptor base may shoot one down.",
          'Missiles land.',
          'The game checks for a winner.',
          'Launchers move.',
        ],
        true,
      ),
      p("Missiles land before anyone moves. What your drone sees helps next round's orders."),
      p('The round resolves once every unit has an order, or when you end it early. A replay follows; Space skips it.'),
    ],
  },
  {
    id: 'orders',
    title: 'Your orders',
    blocks: [
      p('Each launcher and the drone takes one order a round: a launcher moves or fires, never both.'),
      list([
        `Move — up to ${MOVE} hexes; mountains stop launchers. If an unseen enemy is on the hex you chose, the move fails.`,
        `March — a forced march of up to ${MARCH} hexes. The enemy is told the hex you left (never where you went).`,
        `Fire — a missile at any hex up to ${RANGE} away, seen or unseen. The enemy is told the hex you fired from.`,
        `Fly — the drone flies straight up to ${FLIGHT} hexes, over anything.`,
        'Hold / Hover — stay put. A hovering drone still photographs around itself.',
      ]),
    ],
  },
  {
    id: 'finding',
    title: 'Finding things',
    blocks: [
      p('Enemy units stay hidden until detected:'),
      list([
        `Your drone photographs a strip ${SWATH} hexes wide. Sites stay marked for good; launchers show for one round.`,
        'Launches and forced marches reveal the hex they came from, for one round. A launcher that fired is still there; one that marched has gone.',
        'An interceptor base that stops a missile is revealed for good.',
      ]),
      p(`${BASES_UNPHOTOGRAPHABLE ? 'Drones never photograph the base; it shoots them down first, without revealing itself. ' : ''}The board marks where it could be in red, within ${COVER} hexes of the wreck. ${respawnText(RULES.droneRespawnDelay)}`),
      p(`Real or decoy? Fire one missile at a site. A destroyed decoy is announced. If yours lands and nothing is announced, it was the real bunker, now on ${hits(BUNKER_HP - DAMAGE)} — the attacker sees only an impact, as on empty ground. ${BUNKER_HP} missiles landing in one round kill it outright.`),
    ],
  },
  {
    id: 'missiles',
    title: 'Missiles',
    blocks: [
      list([
        `Targets 1–${SPEED} hexes away are hit this round. Targets ${SPEED + 1}–${RANGE} hexes away take a round in the air and land next round.`,
        'A mountain between you and the target blocks the shot; a mountain can be the target.',
        `Each missile deals ${hits(DAMAGE)} to whatever is on the target hex, yours included. Hits in one round add up. Missiles never hit drones.`,
              ]),
      p("Both players see a missile in the air and its target, but the warning comes too late to dodge: missiles land before anyone moves. A launcher on a warned hex will be hit unless the missile is shot down — use it for one last shot."),
      p(`An interceptor base covers every hex within ${COVER} of it and stops at most ${STOPS === 1 ? 'one enemy missile' : `${STOPS} enemy missiles`} a round, plus any drone that flies in. To get past it or kill it, fire ${SATURATE} or more missiles through its cover in one round.`),
    ],
  },
  {
    id: 'endgame',
    title: 'The endgame: dead hand',
    blocks: [
      p('When a real bunker falls, nobody moves that round. Its owner gets one last round: each surviving launcher fires once from where it stands, and nothing else moves. The other side\'s base still defends.'),
      p('Every missile still in the air then lands. If the other bunker falls too, it is a draw; otherwise the attacker wins. No launchers left means no last round. The decoy never triggers this.'),
    ],
  },
  {
    id: 'board',
    title: 'Reading the board',
    blocks: [
      { kind: 'legend' },
      p('The event log on the right keeps everything you have been told, all match.'),
    ],
  },
];

/** Every sentence on the screen, legend included, for tests. */
export function helpText(): string[] {
  const out: string[] = [];
  for (const section of HOW_TO_PLAY) {
    out.push(section.title);
    for (const block of section.blocks) {
      if (block.kind === 'p') out.push(block.text);
      if (block.kind === 'list') out.push(...block.items);
      if (block.kind === 'legend') out.push(...LEGEND.map((entry) => entry.text));
    }
  }
  return out;
}
