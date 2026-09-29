import { useCallback, useEffect, useRef, useState } from 'react';
import GameCanvas from './render/GameCanvas';
import BattleReport from './ui/BattleReport';
import Hud from './ui/Hud';
import HandoffScreen from './ui/HandoffScreen';
import HowToPlay from './ui/HowToPlay';
import SetupPanel from './ui/SetupPanel';
import TitleScreen, { type PlayMode } from './ui/TitleScreen';
import { newMatch, playOnline, setSeating } from './state/match';
import { SERVER_URL, roomInLink } from './net/config';
import { HOTSEAT_SEATS, SOLO_SEATS } from './state/seats';
import { useHandoff, useMatchStarted } from './state/useMatch';
import { toggleMute } from './audio/settings';
import { installUiClicks } from './audio/synth';

// The two presentation layers, stacked: Pixi draws the board underneath, React
// draws the panels on top. Neither owns state — both read from the store in
// `src/state/` (build-order step 9).
//
// Which panel depends on whether a match exists yet (step 10b). The canvas is in
// both, because the board is the input device for secret placement just as it is
// for orders: terrain is public from the first frame (spec §11), and a click on
// a hex is routed by the store, which decides what it meant.
//
// **A pending handoff replaces the lot** (step 10c). Not an overlay on top of
// the board — a swap, so the canvas is unmounted and there is no picture behind
// the prompt at all. That is what makes "the incoming player sees nothing until
// they identify themselves" a fact about the component tree rather than a
// promise about z-index (see `HandoffScreen`).
export default function App() {
  const started = useMatchStarted();
  const handoff = useHandoff();
  // The how-to-play window (presentation Session 4). Plain presentation state:
  // it shows the rules, never anything from the match, so it does not belong in
  // the store.
  // Closed, or open at a section ('' = the top).
  const [help, setHelp] = useState<string | null>(null);
  const openHelp = useCallback((section = '') => setHelp(section), []);
  const closeHelp = useCallback(() => setHelp(null), []);

  // The title screen (V1.5 Session 2). Presentation state like the help window,
  // and deliberately not a store field (gotcha 42: no match yet IS the setup
  // screen). Leaving it picks the seating with the setup panel's own action.
  //
  // A room link (`?room=CODE`, V1.5 Session 6) skips the title: whoever opened
  // it came to join that game.
  const [linkRoom] = useState(() => (SERVER_URL ? roomInLink() : null));
  const [title, setTitle] = useState(linkRoom === null);
  // Once only: StrictMode runs effects twice in development, and a second join
  // would find the seat the first one took.
  const joinedLink = useRef(false);
  useEffect(() => {
    if (!linkRoom || !SERVER_URL || joinedLink.current) return;
    joinedLink.current = true;
    playOnline(SERVER_URL, linkRoom);
  }, [linkRoom]);
  const play = useCallback((mode: PlayMode) => {
    if (mode === 'online') {
      if (SERVER_URL) playOnline(SERVER_URL, null);
    } else {
      setSeating(mode === 'hotseat' ? HOTSEAT_SEATS : SOLO_SEATS);
    }
    setTitle(false);
  }, []);
  // Back to the title from a finished match (end screen, HUD): a fresh board
  // behind it, so `started` is false and the title branch below can show.
  const toTitle = useCallback(() => {
    newMatch(Date.now() % 100000);
    setTitle(true);
  }, []);

  // A handoff closes it, so the next player sits down to their own board rather
  // than to a window the last player left open. Adjusted during render (React's
  // "state from a previous render" pattern) so it is already shut on the frame
  // the board comes back.
  if (handoff && help !== null) setHelp(null);

  // `?` opens it — only while the board is up; the handoff screen binds nothing.
  useEffect(() => {
    if (handoff) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== '?') return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      setHelp('');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handoff]);

  // Sound (V1.5 Session 4): a teletype click on every button, and M to mute
  // from any screen. Neither reads the match, so neither cares about handoffs.
  useEffect(() => installUiClicks(), []);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'm' && event.key !== 'M') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      toggleMute();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Before the board: no match, so no handoff and nobody's news to keep hidden.
  // The help window may open over it; it shows only the rules (gotcha 71).
  if (title && !started && !handoff) {
    return (
      <div className="stage">
        <TitleScreen onPlay={play} onHelp={openHelp} />
        {help !== null && <HowToPlay onClose={closeHelp} start={help || undefined} />}
      </div>
    );
  }

  if (handoff) {
    return (
      <div className="stage">
        <HandoffScreen />
      </div>
    );
  }

  return (
    <div className="stage">
      <GameCanvas />
      {started ? <Hud onHelp={openHelp} onTitle={toTitle} /> : <SetupPanel onHelp={openHelp} />}
      {/* Inside this branch on purpose (V1.1 step 1). A battle report is the
          viewer's private news, so it must be unreachable while the screen is
          blanked for a handoff — mounting it here rather than above the `if`
          makes that structural, exactly as the handoff swap does for the board
          itself. See the header of `BattleReport.tsx`. */}
      <BattleReport onTitle={toTitle} />
      {/* Same branch, same reason (gotchas 58, 62): an overlay on the board,
          so there is no path by which it can draw over the handoff screen. */}
      {help !== null && <HowToPlay onClose={closeHelp} start={help || undefined} />}
    </div>
  );
}
