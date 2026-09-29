// UI LAYER — the small `?` that opens How to play (menu cleanup, 2026-09-28).
//
// It replaced the Legend panels and the full-width "How to play" buttons, which
// between them were a third of the menu's height. Shared by the setup screen
// and the HUD so the two cannot drift into different-looking buttons.

interface Props {
  onClick: () => void;
}

export default function HelpButton({ onClick }: Props) {
  return (
    <button
      type="button"
      className="help-q"
      onClick={onClick}
      title="How to play and legend (?)"
      aria-label="How to play and legend"
    >
      ?
    </button>
  );
}
