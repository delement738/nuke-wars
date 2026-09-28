import { useCallback, useEffect, useState } from 'react';
import GameCanvas from './render/GameCanvas';
import BattleReport from './ui/BattleReport';
import Hud from './ui/Hud';
import HandoffScreen from './ui/HandoffScreen';
import HowToPlay from './ui/HowToPlay';
import SetupPanel from './ui/SetupPanel';
import { useHandoff, useMatchStarted } from './state/useMatch';

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
  const [help, setHelp] = useState(false);
  const openHelp = useCallback(() => setHelp(true), []);
  const closeHelp = useCallback(() => setHelp(false), []);

  // A handoff closes it, so the next player sits down to their own board rather
  // than to a window the last player left open. Adjusted during render (React's
  // "state from a previous render" pattern) so it is already shut on the frame
  // the board comes back.
  if (handoff && help) setHelp(false);

  // `?` opens it — only while the board is up; the handoff screen binds nothing.
  useEffect(() => {
    if (handoff) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== '?') return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      setHelp(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handoff]);

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
      {started ? <Hud onHelp={openHelp} /> : <SetupPanel onHelp={openHelp} />}
      {/* Inside this branch on purpose (V1.1 step 1). A battle report is the
          viewer's private news, so it must be unreachable while the screen is
          blanked for a handoff — mounting it here rather than above the `if`
          makes that structural, exactly as the handoff swap does for the board
          itself. See the header of `BattleReport.tsx`. */}
      <BattleReport />
      {/* Same branch, same reason (gotchas 58, 62): an overlay on the board,
          so there is no path by which it can draw over the handoff screen. */}
      {help && <HowToPlay onClose={closeHelp} />}
    </div>
  );
}
