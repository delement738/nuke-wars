import GameCanvas from './render/GameCanvas';
import BattleReport from './ui/BattleReport';
import Hud from './ui/Hud';
import HandoffScreen from './ui/HandoffScreen';
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
      {started ? <Hud /> : <SetupPanel />}
      {/* Inside this branch on purpose (V1.1 step 1). A battle report is the
          viewer's private news, so it must be unreachable while the screen is
          blanked for a handoff — mounting it here rather than above the `if`
          makes that structural, exactly as the handoff swap does for the board
          itself. See the header of `BattleReport.tsx`. */}
      <BattleReport />
    </div>
  );
}
