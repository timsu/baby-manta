// Corner minimap: district discs in status colors, plaza buildings, stations,
// and the dog. Redraws ~10fps from a position getter so it never re-renders
// React while the dog moves.

import { useEffect, useRef } from "react";
import { statusColorCss } from "./palette.ts";
import type { WorldLayout } from "./types.ts";

const SIZE = 148;

const KIND_DOTS: Record<string, string> = {
  workspace: "#53d7a4",
  "pr-depot": "#53d7a4",
  "linear-depot": "#8a63ff",
  "github-pr": "#53d7a4",
  "linear-ticket": "#8a63ff",
};

export function GameMinimap({
  layout,
  getDog,
  onTravel,
}: {
  layout: WorldLayout;
  getDog: () => { x: number; z: number } | null;
  /** Click-to-travel: converts map pixels back to world coordinates. */
  onTravel?: (x: number, z: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.scale(dpr, dpr);

    const draw = () => {
      const lo = layoutRef.current;
      const scale = (SIZE / 2 - 6) / lo.bounds;
      const cx = SIZE / 2;
      const cy = SIZE / 2;
      ctx.clearRect(0, 0, SIZE, SIZE);
      // Backdrop.
      ctx.fillStyle = "rgba(12, 14, 20, 0.82)";
      ctx.beginPath();
      ctx.roundRect(1, 1, SIZE - 2, SIZE - 2, 14);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // The street.
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(6, cy - 2.5, SIZE - 12, 5);
      // District plots.
      for (const zone of lo.zones) {
        const color = statusColorCss(zone.status);
        const w = Math.max(4, zone.halfW * 2 * scale);
        const h = Math.max(3, zone.halfD * 2 * scale);
        ctx.fillStyle = `${color}${zone.count > 0 ? "42" : "1a"}`;
        ctx.fillRect(cx + zone.x * scale - w / 2, cy + zone.z * scale - h / 2, w, h);
        ctx.strokeStyle = `${color}${zone.count > 0 ? "cc" : "55"}`;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + zone.x * scale - w / 2, cy + zone.z * scale - h / 2, w, h);
      }

      // Buildings + stations.
      for (const it of lo.interactables) {
        if (it.kind === "card" || it.kind === "question") continue;
        ctx.fillStyle = KIND_DOTS[it.kind] ?? "#9aa3b5";
        ctx.beginPath();
        ctx.arc(cx + it.x * scale, cy + it.z * scale, it.kind.endsWith("depot") ? 3 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // The dog.
      const dog = getDog();
      if (dog) {
        ctx.fillStyle = "#ffe27a";
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx + dog.x * scale, cy + dog.z * scale, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };

    draw();
    const interval = setInterval(draw, 120);
    return () => clearInterval(interval);
  }, [getDog]);

  return (
    <canvas
      ref={canvasRef}
      className={`game-minimap ${onTravel ? "clickable" : ""}`}
      style={{ width: SIZE, height: SIZE }}
      aria-label="Minimap"
      data-testid="game-minimap"
      onClick={(e) => {
        if (!onTravel) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const lo = layoutRef.current;
        const scale = (SIZE / 2 - 6) / lo.bounds;
        const wx = (e.clientX - rect.left - SIZE / 2) / scale;
        const wz = (e.clientY - rect.top - SIZE / 2) / scale;
        onTravel(Math.max(-lo.bounds, Math.min(lo.bounds, wx)), Math.max(-lo.bounds, Math.min(lo.bounds, wz)));
      }}
    />
  );
}
