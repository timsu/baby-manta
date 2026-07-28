// Night-campus color system. Extends the app's #131417 theme into the world.

import type { CardStatus } from "@manta/shared";

export const NIGHT = {
  skyTop: 0x06070d,
  skyHorizon: 0x1a2133,
  skyGlow: 0x27556b,
  fog: 0x0b0d14,
  ground: 0x1a1d25,
  groundEdge: 0x0e1016,
  zoneStrip: 0x232833,
  path: 0x2b3242,
  pedestal: 0x2a2f3c,
  structure: 0x333a4c,
  structureDark: 0x232733,
  lampWarm: 0xffc98a,
  accent: 0x6ea8ff,
  text: "#e8eaf0",
  textDim: "#9aa3b5",
  panelBg: "rgba(14, 16, 22, 0.92)",
} as const;

export const STATUS_COLORS: Readonly<Record<CardStatus, number>> = {
  backlog: 0x8a93a6,
  bot_working: 0x4f8cff,
  needs_help: 0xff5d5d,
  ready_to_test: 0xffc94d,
  interactive: 0xb07aff,
  pr_review: 0x53d7a4,
  investigation_complete: 0x5bc8e8,
  done: 0x3ddc84,
  canceled: 0x666b76,
};

export function statusColorCss(status: CardStatus): string {
  return `#${STATUS_COLORS[status].toString(16).padStart(6, "0")}`;
}

export function checksColorCss(checksStatus: string, mergeable: string): string {
  if (mergeable === "CONFLICTING") return "#ff8a5d";
  if (checksStatus === "failing") return "#ff5d5d";
  if (checksStatus === "pending") return "#ffc94d";
  if (checksStatus === "passing") return "#3ddc84";
  return "#9aa3b5";
}
