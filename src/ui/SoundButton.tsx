// UI LAYER — the sound settings (V1.5 Session 4).
//
// A small speaker next to the `?`, in the same round style, that opens a
// console popover with a mute switch and a volume slider. It sits on the title
// screen, the setup screen and the HUD. It reads and writes only the sound
// settings (`src/audio/settings.ts`), never the match, so like the help window
// it has nothing on it that could belong to one player.
//
// `M` mutes and unmutes from anywhere (bound in `App`).

import { useEffect, useRef, useState } from 'react';
import { setMuted, setVolume } from '../audio/settings';
import { playSound } from '../audio/synth';
import { useSoundSettings } from '../audio/useSettings';
import './sound.css';

interface Props {
  /** Extra class for placement (the title screen pins it to a corner). */
  className?: string;
}

export default function SoundButton({ className }: Props) {
  const { volume, muted } = useSoundSettings();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const silent = muted || volume === 0;

  // Click anywhere else, or Escape, closes it.
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`sound ${className ?? ''}`} ref={rootRef}>
      <button
        type="button"
        className="help-q sound-btn"
        onClick={() => setOpen((o) => !o)}
        title="Sound (M to mute)"
        aria-label="Sound settings"
        aria-expanded={open}
      >
        <SpeakerIcon silent={silent} />
      </button>
      {open && (
        <div className="sound-pop" role="dialog" aria-label="Sound">
          <div className="sound-title">Sound</div>
          <label className="sound-row">
            <input
              type="checkbox"
              checked={muted}
              onChange={(e) => setMuted(e.target.checked)}
            />
            Mute <span className="sound-key">M</span>
          </label>
          <label className="sound-row">
            Volume
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              // A click at the new level, so the player hears what they chose.
              onPointerUp={() => playSound('click')}
              onKeyUp={() => playSound('click')}
            />
            <span className="sound-value">{muted ? 'off' : `${Math.round(volume * 100)}%`}</span>
          </label>
        </div>
      )}
    </div>
  );
}

function SpeakerIcon({ silent }: { silent: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor" />
      {silent ? (
        <path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
      ) : (
        <path
          d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
        />
      )}
    </svg>
  );
}
