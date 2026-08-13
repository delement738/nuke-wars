import GameCanvas from './render/GameCanvas';
import Hud from './ui/Hud';
import SetupPanel from './ui/SetupPanel';
import { useMatchStarted } from './state/useMatch';

// The two presentation layers, stacked: Pixi draws the board underneath, React
// draws the panels on top. Neither owns state — both read from the store in
// `src/state/` (build-order step 9).
//
// Which panel depends on whether a match exists yet (step 10b). The canvas is in
// both, because the board is the input device for secret placement just as it is
// for orders: terrain is public from the first frame (spec §11), and a click on
// a hex is routed by the store, which decides what it meant.
export default function App() {
  const started = useMatchStarted();

  return (
    <div className="stage">
      <GameCanvas />
      {started ? <Hud /> : <SetupPanel />}
    </div>
  );
}
