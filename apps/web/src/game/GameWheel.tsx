// The hold-E radial wheel — a screen-space overlay centered on the character,
// the way action games surface deep option sets without menus-of-menus.
// Selection: A/D/arrows rotate, hovering a sector selects, click or releasing
// E confirms, Esc steps back/closes.

import type { WheelItem } from "./wheelItems.ts";

const RADIUS = 150;

export function GameWheel({
  title,
  items,
  selected,
  center,
  onSelect,
  onConfirm,
}: {
  title: string;
  items: WheelItem[];
  selected: number;
  /** Screen-space anchor (% of container) — the dog's projected position. */
  center: { xPct: number; yPct: number };
  onSelect: (index: number) => void;
  onConfirm: (index: number) => void;
}) {
  const current = items[selected];
  return (
    <div className="game-wheel" data-testid="game-wheel" role="menu" aria-label={title}>
      <div className="game-wheel-dial" style={{ left: `${center.xPct}%`, top: `${center.yPct}%` }}>
        {items.map((item, i) => {
          // Start at 12 o'clock, distribute clockwise.
          const angle = (i / items.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * RADIUS;
          const y = Math.sin(angle) * RADIUS;
          return (
            <button
              key={item.id}
              role="menuitem"
              className={`game-wheel-item ${i === selected ? "selected" : ""}`}
              style={{
                transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${i === selected ? 1.12 : 1})`,
                ...(item.accent ? { borderColor: item.accent } : {}),
              }}
              onMouseEnter={() => onSelect(i)}
              onClick={() => onConfirm(i)}
            >
              <span className="game-wheel-icon">{item.icon}</span>
            </button>
          );
        })}
        <div className="game-wheel-hub">
          <div className="game-wheel-title">{title}</div>
          <div className="game-wheel-label" style={current?.accent ? { color: current.accent } : undefined}>
            {current?.label ?? ""}
          </div>
          <div className="game-wheel-hint">A / D choose · release E or click · esc</div>
        </div>
      </div>
    </div>
  );
}
