// Whistle search overlay ("/"): type, Enter to whistle — the matching kiosk
// gets a light-pillar beacon and the dog auto-runs to it.

import { useEffect, useRef, useState } from "react";

export function GameSearch({ onSearch, onClose }: { onSearch: (query: string) => void; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="game-search" data-testid="game-search">
      <span className="game-search-icon">🔦</span>
      <input
        ref={inputRef}
        value={value}
        placeholder="Find a card, PR, or ticket…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            onSearch(value);
            onClose();
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
        onBlur={onClose}
      />
      <kbd>↵</kbd>
    </div>
  );
}
