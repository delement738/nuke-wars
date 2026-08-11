import { describe, expect, it } from 'vitest';
import { RULES, TERRAIN_DEFS, TERRAIN_GEN, UNIT_DEFS } from './defs';

/**
 * These tests do not check behaviour — they check that the balance tables still
 * express the rules the spec is built on. Every one of them guards an invariant
 * that a plausible, well-meaning balance edit could break silently, because the
 * code would keep compiling and every other test would keep passing.
 */

describe('placement terrain (spec §12)', () => {
  it('offers the decoy exactly the terrain it offers the bunker', () => {
    // THE indistinguishability test. If the decoy were barred from terrain the
    // bunker allowed — or allowed terrain the bunker was barred from — then
    // every site on that terrain would be provably real or provably fake, and
    // the enemy would identify the bunker by reading the rulebook instead of by
    // spending a missile. §12: every rule that mentions the bunker must apply
    // identically to the decoy, HP being the single permitted exception.
    expect([...RULES.placementTerrain.decoy].sort()).toEqual(
      [...RULES.placementTerrain.bunker].sort(),
    );
  });

  it('keeps HP as the only difference between bunker and decoy', () => {
    // The other half of the same principle, on the unit table.
    const { hp: bunkerHp, ...bunkerRest } = UNIT_DEFS.bunker;
    const { hp: decoyHp, ...decoyRest } = UNIT_DEFS.decoy;
    expect(decoyRest).toEqual(bunkerRest);
    expect(decoyHp).toBeLessThan(bunkerHp);
  });

  it('lets static structures be built on ground launchers cannot cross', () => {
    // The point of the 2026-08-11 terrain change: a mountain stops a launcher
    // but not a construction crew, so mountains are bunker sites that ground
    // probing can never bump into (§9, §11) — at the price of being a small,
    // publicly-known set of candidate hexes.
    expect(TERRAIN_DEFS.mountain.groundPassable).toBe(false);
    expect(RULES.placementTerrain.bunker).toContain('mountain');
    expect(RULES.placementTerrain.interceptor).toContain('mountain');
  });
});

describe('terrain generation constants (spec §7)', () => {
  it('targets a fraction inside the band the generator enforces', () => {
    // Setting mountainFraction outside its own band would make every seed fail
    // validation and generateMap throw — 20 attempts later, at runtime, in the
    // browser. Cheaper to catch here.
    expect(TERRAIN_GEN.mountainFraction).toBeGreaterThanOrEqual(
      TERRAIN_GEN.mountainFractionBand.min,
    );
    expect(TERRAIN_GEN.mountainFraction).toBeLessThanOrEqual(
      TERRAIN_GEN.mountainFractionBand.max,
    );
  });

  it('allows an approach at least as long as an unobstructed one', () => {
    // On a mountain-free board a launcher closes to firing range in
    // (gap - missileRange) steps. If maxApproachCost were ever tuned below
    // that, no map could pass validation however open it was.
    const gap = 14; // rows between the two launcher lines, per §7
    expect(TERRAIN_GEN.maxApproachCost).toBeGreaterThanOrEqual(
      gap - RULES.missileRange,
    );
  });
});
