import GameCanvas from './render/GameCanvas';
import Hud from './ui/Hud';

// The two presentation layers, stacked: Pixi draws the board underneath, React
// draws the HUD on top. Neither owns state — both read the current viewer's
// filtered view from the store in `src/state/` (build-order step 9).
export default function App() {
  return (
    <div className="stage">
      <GameCanvas />
      <Hud />
    </div>
  );
}
