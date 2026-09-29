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
| Bunker | `#0b0f14` | The room: page background, the in-game board's surround |
| Console | `#121210`–`#1d1c19` | HUD panels, buttons, help window |

**Own = blue and enemy = red stay.** On the paper board they are deepened (`#2f6fc4`, `#b3362a`; see Board and pieces); in the dark panels the text keeps the brighter `#5aa9ff` / `#ff8371`. The title map is all red because it shows no sides — it is decoration, not a match.

## Type
- **Saira Stencil One** — the name only (and any future big stencilled headline, e.g. the end screen's VICTORY / DEFEAT in Session 3).
- **Oswald** (500/600/700), uppercase with open letter-spacing — taglines, buttons, console labels.
- **Monospace** (`ui-monospace, Menlo`) — grid references on the title map, the event log, the "viewing P1" tag and the end screen's kicker line.
- The HUD's body text stays the system sans; headings and buttons are Oswald (Session 3). The end screen's verdict and the hotseat handoff's big player name are Saira Stencil One.
- Both web fonts load from Google Fonts in `index.html`, with Impact / Arial Narrow as fallbacks if the service is unreachable. Nothing is installed from npm.

## Board and pieces
*Built in V1.5 Session 3 (the designer picked "paper map" over a dark board, for one consistent feel with the title).*

- **The board is the plotting table:** plains are map paper, mountains are khaki hills marked with small clustered peaks (an old military map's mountain symbol, right faces shaded), hex edges are a faint grid line, and the bunker-black table shows around the edge. Colours live in **`src/render/palette.ts`**, read by both the Pixi board (`COLOR` in `draw.ts`) and the How-to-play legend, so they cannot drift.
- **Hills are khaki, not the title map's green**, because on the board green means "you may move here"; a green hill beside a green move wash read as the same thing.
- **Pieces:** yours are blue plates (`#2f6fc4`) with the emblem in paper colour; enemy marks are stencil red (`#b3362a`) with the title art's thin ink outline. Wrecks are warm grey.
- **Order and setup colours were deepened for paper:** move green `#1f8f55`, march olive `#5f8f00`, fire orange `#d46a12`, drone violet `#7a45c9`, placement gold `#b47a00`; the selection ring is ink. `palette.test.ts` checks every mark still contrasts with both paper and hills.
- **Replay:** hotter burst yellow and warm smoke so effects show on cream; labels are ink outlined in paper, like notes on a map; the caption stays in a dark console box.
- **Panels (HUD, log, help, reports) are the bunker's consoles:** warm near-black, paper-coloured text, Oswald headings and buttons in capitals, the event log in a typewriter face under ruled "ROUND n" headers.
- **End of match:** the game-over report is drawn as the title's paper plate — MATCH OVER · ROUND n, the verdict stencilled big (VICTORY in your blue, DEFEAT in stencil red, DRAW in ink), the report's headline and sentence, then *See enemy positions* (the final reveal), *Play again*, *Title screen*.

## Motion and sound
- **Motion:** slow and steady rather than flashy. The title map drifts at 20 px/s; the only other motion on the title is the "Press Enter" blink. In play, a busy round's replay stays 4–6 s (presentation Session 1 ruling).
- **Sound (Session 4):** to match the bunker — teletype clicks for UI, a low siren or klaxon sting for launch warnings, muffled distant thumps for impacts, a relay click for intercepts. Nothing arcade-bright.
  - *Built in V1.5 Session 4.* All four are synthesised with Web Audio in `src/audio/synth.ts` (no audio files): the click is a short band-passed noise tick and bounce; the klaxon two sawtooth tones (196/165 Hz) alternating behind a low-pass "wall"; the thump a sine falling 72 → 30 Hz under low-passed rumble; the relay two sharp contacts 45 ms apart. The replay plays **one sound per beat** (a volley is one klaxon), timed from its timeline (`src/audio/cues.ts`); movement, recon, damage and the verdict are silent.
  - **Settings:** a small speaker beside each `?` (and in the title screen's top-right corner) opens a console popover with Mute and Volume; `M` mutes from anywhere. Default volume 70%. Saved per browser.

## Constraints that come from the rules
- Nothing drawn may tell the real bunker from the decoy to the enemy (spec §12; gotchas 31, 69, 72).
- The title screen shows no match state at all: it is presentation state in `App`, never a store stage (gotcha 42, gotcha 74).
- Desktop and tablet only; phones get a notice (on the title screen, with a "Continue anyway").
