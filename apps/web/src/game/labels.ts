// Hi-DPI canvas billboards: card holo-faces, district gate banners, and small
// name plates. All text rendering for the world lives here so typography stays
// consistent (Chakra Petch once the lazy game chunk loads its @fontsource CSS).

import * as THREE from "three";
import { checksColorCss, NIGHT, statusColorCss } from "./palette.ts";
import type { CardFace, ZoneDef } from "./types.ts";

const DPR = 2;
const FONT = "'Chakra Petch', 'Avenir Next', system-ui, sans-serif";

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = w * DPR;
  canvas.height = h * DPR;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(DPR, DPR);
  return [canvas, ctx];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function chip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: { color?: string; bg?: string; border?: string; size?: number; bold?: boolean },
): number {
  const size = opts.size ?? 12;
  ctx.font = `${opts.bold ? 600 : 500} ${size}px ${FONT}`;
  const w = Math.ceil(ctx.measureText(text).width) + 14;
  const h = size + 9;
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
  }
  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = 1.2;
    roundRect(ctx, x + 0.6, y + 0.6, w - 1.2, h - 1.2, h / 2);
    ctx.stroke();
  }
  ctx.fillStyle = opts.color ?? NIGHT.text;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 7, y + h / 2 + 0.5);
  return w;
}

function spriteFromCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number, worldScale: number): THREE.Sprite {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(cssW * worldScale, cssH * worldScale, 1);
  return sprite;
}

/** The holo-face for a card kiosk: same info hierarchy as the 2D card. */
export function cardFaceSprite(face: CardFace): THREE.Sprite {
  const W = 340;
  const H = 148;
  const [canvas, ctx] = makeCanvas(W, H);
  const status = statusColorCss(face.status);

  // Panel.
  ctx.fillStyle = NIGHT.panelBg;
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 16);
  ctx.fill();
  ctx.strokeStyle = status;
  ctx.lineWidth = 2;
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 16);
  ctx.stroke();
  // Status edge glow along the top.
  const glow = ctx.createLinearGradient(0, 0, 0, 26);
  glow.addColorStop(0, `${status}55`);
  glow.addColorStop(1, `${status}00`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.roundRect(2, 2, W - 4, 26, [16, 16, 0, 0]);
  ctx.fill();

  // Header row: emoji, display id, status pill on the right.
  ctx.textBaseline = "middle";
  ctx.font = `18px ${FONT}`;
  ctx.fillText(face.emoji, 14, 26);
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = NIGHT.textDim;
  ctx.fillText(face.displayId, 40, 26);
  if (face.workerLive) {
    const idW = ctx.measureText(face.displayId).width;
    ctx.fillStyle = "#3ddc84";
    ctx.beginPath();
    ctx.arc(48 + idW + 6, 26, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = `600 12px ${FONT}`;
  const pillW = Math.ceil(ctx.measureText(face.statusLabel.toUpperCase()).width) + 14;
  chip(ctx, face.statusLabel.toUpperCase(), W - pillW - 12, 15, { color: status, border: status, size: 11, bold: true });

  // Title, up to two lines.
  ctx.font = `600 17px ${FONT}`;
  ctx.fillStyle = NIGHT.text;
  const words = face.title.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > W - 32 && line) {
      lines.push(line);
      line = w;
      if (lines.length === 2) break;
    } else {
      line = next;
    }
  }
  if (lines.length < 2 && line) lines.push(line);
  if (lines.length === 2 && line && lines[1] !== line) lines[1] = `${lines[1]!.slice(0, Math.max(0, lines[1]!.length - 1))}…`;
  lines.forEach((l, i) => ctx.fillText(l, 16, 58 + i * 23));

  // Footer row: repo chip, PR/checks pill, linear chip, assignee on the right.
  let fx = 14;
  fx += chip(ctx, face.repo.split("/")[1] ?? face.repo, fx, H - 34, { color: NIGHT.textDim, bg: "rgba(255,255,255,0.06)" }) + 8;
  if (face.prNumber !== null) {
    const cc = checksColorCss(face.checksStatus, face.mergeable);
    fx += chip(ctx, `PR #${face.prNumber}`, fx, H - 34, { color: cc, border: cc }) + 8;
  }
  if (face.linearIssueIdentifier) {
    fx += chip(ctx, face.linearIssueIdentifier, fx, H - 34, { color: "#8a63ff", border: "#8a63ff" }) + 8;
  }
  if (face.assigneeInitials) {
    ctx.fillStyle = "rgba(110, 168, 255, 0.25)";
    ctx.beginPath();
    ctx.arc(W - 28, H - 23, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = NIGHT.accent === 0x6ea8ff ? "#6ea8ff" : "#6ea8ff";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.font = `600 10px ${FONT}`;
    ctx.fillStyle = NIGHT.text;
    ctx.textAlign = "center";
    ctx.fillText(face.assigneeInitials, W - 28, H - 22);
    ctx.textAlign = "left";
  }

  return spriteFromCanvas(canvas, W, H, 0.0105);
}

/** Mid-distance kiosk plate: emoji + display id (+ live dot). Small enough
 *  that a packed district stays readable from across the world. */
export function miniPlateSprite(face: CardFace): THREE.Sprite {
  const [measureCanvas, measureCtx] = makeCanvas(10, 10);
  void measureCanvas;
  measureCtx.font = `600 15px ${FONT}`;
  const W = Math.ceil(measureCtx.measureText(face.displayId).width) + 52 + (face.workerLive ? 12 : 0);
  const H = 30;
  const [canvas, ctx] = makeCanvas(W, H);
  const status = statusColorCss(face.status);
  ctx.fillStyle = NIGHT.panelBg;
  roundRect(ctx, 1, 1, W - 2, H - 2, 8);
  ctx.fill();
  ctx.strokeStyle = `${status}88`;
  ctx.lineWidth = 1.4;
  roundRect(ctx, 1, 1, W - 2, H - 2, 8);
  ctx.stroke();
  ctx.textBaseline = "middle";
  ctx.font = `14px ${FONT}`;
  ctx.fillText(face.emoji, 8, H / 2 + 1);
  ctx.font = `600 15px ${FONT}`;
  ctx.fillStyle = NIGHT.text;
  ctx.fillText(face.displayId, 32, H / 2 + 1);
  if (face.workerLive) {
    ctx.fillStyle = "#3ddc84";
    ctx.beginPath();
    ctx.arc(W - 12, H / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return spriteFromCanvas(canvas, W, H, 0.012);
}

interface ItemFaceSpec {
  icon: string;
  idText: string;
  title: string;
  accent: string;
  chips: { text: string; color?: string }[];
  initials?: string;
}

/** Detail face for non-card work items (PRs, Linear tickets) — same info
 *  hierarchy and LOD treatment as card faces. */
function itemFaceSprite(spec: ItemFaceSpec): THREE.Sprite {
  const W = 320;
  const H = 132;
  const [canvas, ctx] = makeCanvas(W, H);

  ctx.fillStyle = NIGHT.panelBg;
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 16);
  ctx.fill();
  ctx.strokeStyle = spec.accent;
  ctx.lineWidth = 2;
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 16);
  ctx.stroke();
  const glow = ctx.createLinearGradient(0, 0, 0, 26);
  glow.addColorStop(0, `${spec.accent}55`);
  glow.addColorStop(1, `${spec.accent}00`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.roundRect(2, 2, W - 4, 26, [16, 16, 0, 0]);
  ctx.fill();

  ctx.textBaseline = "middle";
  ctx.font = `16px ${FONT}`;
  ctx.fillText(spec.icon, 14, 25);
  ctx.font = `700 14px ${FONT}`;
  ctx.fillStyle = spec.accent;
  ctx.fillText(spec.idText, 40, 25);

  ctx.font = `600 16px ${FONT}`;
  ctx.fillStyle = NIGHT.text;
  const words = spec.title.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > W - 32 && line) {
      lines.push(line);
      line = w;
      if (lines.length === 2) break;
    } else {
      line = next;
    }
  }
  if (lines.length < 2 && line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, 16, 54 + i * 21));

  let fx = 14;
  for (const chipSpec of spec.chips) {
    fx += chip(ctx, chipSpec.text, fx, H - 32, {
      color: chipSpec.color ?? NIGHT.textDim,
      bg: chipSpec.color ? undefined : "rgba(255,255,255,0.06)",
      border: chipSpec.color,
    }) + 8;
  }
  if (spec.initials) {
    ctx.fillStyle = "rgba(110, 168, 255, 0.25)";
    ctx.beginPath();
    ctx.arc(W - 26, H - 22, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 10px ${FONT}`;
    ctx.fillStyle = NIGHT.text;
    ctx.textAlign = "center";
    ctx.fillText(spec.initials, W - 26, H - 21);
    ctx.textAlign = "left";
  }
  return spriteFromCanvas(canvas, W, H, 0.0105);
}

export function prFaceSprite(pr: { number: number; title: string; repo: string; branch: string; author: { login: string } | null }): THREE.Sprite {
  return itemFaceSprite({
    icon: "⬡",
    idText: `PR #${pr.number}`,
    title: pr.title,
    accent: "#53d7a4",
    chips: [
      { text: pr.repo.split("/")[1] ?? pr.repo },
      { text: pr.branch, color: "#53d7a4" },
      ...(pr.author ? [{ text: `@${pr.author.login}` }] : []),
    ],
  });
}

export function ticketFaceSprite(t: { identifier: string; title: string; repo: string | null; priority: number; state: { name: string } }): THREE.Sprite {
  const priority = t.priority > 0 ? ["", "urgent", "high", "medium", "low"][t.priority] ?? "" : "";
  return itemFaceSprite({
    icon: "📋",
    idText: t.identifier,
    title: t.title,
    accent: "#8a63ff",
    chips: [
      ...(t.repo ? [{ text: t.repo.split("/")[1] ?? t.repo }] : []),
      { text: t.state.name, color: "#8a63ff" },
      ...(priority ? [{ text: priority, color: priority === "urgent" ? "#ff5d5d" : undefined }] : []),
    ],
  });
}

/** Mini id plate for items (mid-range LOD). */
export function miniItemPlate(icon: string, idText: string, accent: string): THREE.Sprite {
  const [measureCanvas, measureCtx] = makeCanvas(10, 10);
  void measureCanvas;
  measureCtx.font = `600 15px ${FONT}`;
  const W = Math.ceil(measureCtx.measureText(idText).width) + 50;
  const H = 30;
  const [canvas, ctx] = makeCanvas(W, H);
  ctx.fillStyle = NIGHT.panelBg;
  roundRect(ctx, 1, 1, W - 2, H - 2, 8);
  ctx.fill();
  ctx.strokeStyle = `${accent}88`;
  ctx.lineWidth = 1.4;
  roundRect(ctx, 1, 1, W - 2, H - 2, 8);
  ctx.stroke();
  ctx.textBaseline = "middle";
  ctx.font = `13px ${FONT}`;
  ctx.fillText(icon, 8, H / 2 + 1);
  ctx.font = `600 15px ${FONT}`;
  ctx.fillStyle = NIGHT.text;
  ctx.fillText(idText, 30, H / 2 + 1);
  return spriteFromCanvas(canvas, W, H, 0.012);
}

/** District gate banner: emoji, title, live count. */
export function bannerSprite(zone: ZoneDef): THREE.Sprite {
  const W = 320;
  const H = 64;
  const [canvas, ctx] = makeCanvas(W, H);
  const status = statusColorCss(zone.status);

  ctx.fillStyle = NIGHT.panelBg;
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 14);
  ctx.fill();
  ctx.strokeStyle = `${status}aa`;
  ctx.lineWidth = 2;
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 14);
  ctx.stroke();

  ctx.textBaseline = "middle";
  ctx.font = `24px ${FONT}`;
  ctx.fillText(zone.emoji, 16, H / 2 + 1);
  ctx.font = `700 20px ${FONT}`;
  ctx.fillStyle = NIGHT.text;
  ctx.fillText(zone.title.toUpperCase(), 52, H / 2 + 1);
  if (zone.count > 0) {
    ctx.font = `700 16px ${FONT}`;
    const countText = String(zone.count);
    const cw = Math.ceil(ctx.measureText(countText).width) + 16;
    ctx.fillStyle = `${status}33`;
    roundRect(ctx, W - cw - 14, H / 2 - 13, cw, 26, 13);
    ctx.fill();
    ctx.fillStyle = status;
    ctx.textAlign = "center";
    ctx.fillText(countText, W - cw / 2 - 14, H / 2 + 1);
    ctx.textAlign = "left";
  }

  return spriteFromCanvas(canvas, W, H, 0.0115);
}

/** Small name plate for buildings, portals, and piles. */
export function plateSprite(text: string, opts?: { accent?: string; size?: number }): THREE.Sprite {
  const [measureCanvas, measureCtx] = makeCanvas(10, 10);
  void measureCanvas;
  measureCtx.font = `600 16px ${FONT}`;
  const W = Math.min(320, Math.ceil(measureCtx.measureText(text).width) + 34);
  const H = 38;
  const [canvas, ctx] = makeCanvas(W, H);
  ctx.fillStyle = NIGHT.panelBg;
  roundRect(ctx, 1, 1, W - 2, H - 2, 10);
  ctx.fill();
  ctx.strokeStyle = opts?.accent ? `${opts.accent}99` : "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, 1, 1, W - 2, H - 2, 10);
  ctx.stroke();
  ctx.font = `600 16px ${FONT}`;
  ctx.fillStyle = NIGHT.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, W / 2, H / 2 + 1);
  return spriteFromCanvas(canvas, W, H, (opts?.size ?? 1) * 0.012);
}
