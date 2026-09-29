# Nuke Wars — art direction

*Written in V1.5 Session 2 (identity and title screen, 2026-09-29). Sessions 3–4 follow it. The designer's reference art is `public/art/title-inspo.png`.*

## Mood
**A Cold War command bunker, looking down at a plotting table.** The room is dark; a lamp pools light on a paper war map, where the forces are marked in red stencil and the missile tracks are drawn in by hand. The feel is serious and a little analogue: paper, ink, stencil, a situation-room monitor's scanlines. Nothing glossy, nothing neon.

Two surfaces carry it:
- **Paper** (the map/plotting table): cream, grid, contour lines, red pieces, ink arrows. The title screen's moving background is this.
- **Bunker** (the room and its consoles): near-black panels with cream lettering. The in-game HUD already lives here (`#0b0f14` and the dark panels in `src/ui/hud.css`).

## Name treatment and title screen
- **"NUKE WARS"** is set in a heavy stencil (Saira Stencil One), uppercase, in stencil red, on a cream paper plate edged top and bottom in ink. The tagline under it, **"DISARM OR DECAPITATE THE ENEMY REGIME"**, is set in bold condensed ink (Oswald 700).
- **The title screen** (`src/ui/TitleScreen.tsx`, styles in `src/ui/title.css`):
  1. **Moving map.** A seamless 1440 × 960 tile of plotting table (`src/ui/titleBackdrop.ts`), drawn from the game's own unit emblems (`src/render/emblems.ts`), repeats across the screen and **slides left at 20 px a second** (the designer's number; one tile passes every 72 s). A CSS transform on a layer one tile wider than the screen, so it runs on the GPU and loops without a seam. Anyone whose system asks for reduced motion gets a still map.
  2. **The lamp.** A vignette falling to bunker black at the edges, a faint warm pool in the centre and fine scanlines.
  3. **The card.** The paper name plate, then a dark console with "— STRATEGIC ASSETS DEPLOYED —", three stencilled buttons (**Play vs CPU** in red, **Two players (hotseat)**, **How to play**) and a slowly blinking **"PRESS ENTER TO BEGIN CAMPAIGN"**. Enter plays against the CPU.
- **Why the reference picture is not the background:** it has the title lettered into it, a phone's Edit/Share buttons in one corner and a cut-off credit, and its edges do not meet, so it cannot loop. It stays in `public/art/` as the style reference.
- **Favicon:** the bunker emblem in red inside a red target ring, on paper (`public/favicon.svg`). The page title is "Nuke Wars".

## Palette
| Name | Hex | Used for |
|---|---|---|
| Paper | `#e9e4d0` | Map background, name plate, lettering on dark |
| Land | `#d3d9bb` | Hill tint on the map |
| Grid | `#cbc4a8` | Map grid lines |
| Contour | `#b8b396` | Contour lines |
| Label | `#9a937a` | Grid references (A1, B3 …) |
| Stencil red | `#b3362a` | The name, pieces on the paper map, solid missile tracks, target rings, the main button |
| Hot red | `#d0412f` | Button hover/focus |
| Ink | `#29251f` | Tagline, outlines, dashed tracks, dark buttons |
| Smoke | `#a6998a` | Mushroom clouds |
| Bunker | `#0b0f14` | The room: page background, consoles, the in-game board's surround |

**On the board, own = blue (`#5aa9ff`) and enemy = red (`#ff8371`) stay** (established by the board, the legend and the battle reports). The title map is all red because it shows no sides — it is decoration, not a match. Session 3 decides how the board's blue/red sit on the new paper/bunker surfaces; it must not make the two sides harder to tell apart.

## Type
- **Saira Stencil One** — the name only (and any future big stencilled headline, e.g. the end screen's VICTORY / DEFEAT in Session 3).
- **Oswald** (500/600/700), uppercase with open letter-spacing — taglines, buttons, console labels.
- **Monospace** (`ui-monospace, Menlo`) — grid references, and a candidate for the event log's round/time stamps in Session 3.
- The in-game HUD body text stays the system sans for now; Session 3 decides whether panels move to Oswald for headings.
- Both web fonts load from Google Fonts in `index.html`, with Impact / Arial Narrow as fallbacks if the service is unreachable. Nothing is installed from npm.

## Board and pieces
*Session 3.* The unit emblems stay (`src/render/emblems.ts`, gotcha 72): the title screen already shows them in the paper style (red fill, thin ink outline), which is the target look for pieces on a restyled board. Terrain should move toward the paper map: plains as paper, mountains as contour-lined hills.

## Motion and sound
- **Motion:** slow and steady rather than flashy. The title map drifts at 20 px/s; the only other motion on the title is the "Press Enter" blink. In play, a busy round's replay stays 4–6 s (presentation Session 1 ruling).
- **Sound (Session 4):** to match the bunker — teletype clicks for UI, a low siren or klaxon sting for launch warnings, muffled distant thumps for impacts, a relay click for intercepts. Nothing arcade-bright.

## Constraints that come from the rules
- Nothing drawn may tell the real bunker from the decoy to the enemy (spec §12; gotchas 31, 69, 72).
- The title screen shows no match state at all: it is presentation state in `App`, never a store stage (gotcha 42, gotcha 74).
- Desktop and tablet only; phones get a notice (on the title screen, with a "Continue anyway").
