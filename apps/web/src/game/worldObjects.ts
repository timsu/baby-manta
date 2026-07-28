// Procedural world meshes: card kiosks, district gates, plaza buildings,
// portals, and question beacons. Pure geometry/material construction — layout
// decides where things go, scene.ts composes them.

import * as THREE from "three";
import { NIGHT, STATUS_COLORS } from "./palette.ts";
import { bannerSprite, cardFaceSprite, miniItemPlate, miniPlateSprite, plateSprite, prFaceSprite, ticketFaceSprite } from "./labels.ts";
import type { Interactable, ZoneDef } from "./types.ts";

function std(color: number, opts?: { rough?: number; metal?: number; emissive?: number; emissiveIntensity?: number }) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts?.rough ?? 0.85,
    metalness: opts?.metal ?? 0.1,
    emissive: opts?.emissive ?? 0x000000,
    emissiveIntensity: opts?.emissiveIntensity ?? 1,
  });
}

function glowSprite(color: number, size: number, opacity = 0.5): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  const hex = `#${color.toString(16).padStart(6, "0")}`;
  g.addColorStop(0, hex);
  g.addColorStop(1, `${hex}00`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  sprite.scale.setScalar(size);
  return sprite;
}

export interface KioskHandle {
  group: THREE.Group;
  /** Status-colored trim; scene pulses this for live workers / highlight. */
  trim: THREE.MeshStandardMaterial;
  workerLive: boolean;
  /** LOD labels: the full holo-face (near) and the mini id plate (mid). */
  fullLabel: THREE.Sprite;
  miniLabel: THREE.Sprite;
  interactableId: string;
}

/** A card kiosk: pedestal + status trim + LOD holo-face. */
export function buildKiosk(it: Interactable): KioskHandle {
  const g = new THREE.Group();
  const face = it.data!.face!;
  const color = STATUS_COLORS[face.status];

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.18, 6), std(NIGHT.structureDark, { rough: 0.7, metal: 0.4 }));
  base.position.y = 0.09;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 1.05, 6), std(NIGHT.pedestal, { rough: 0.6, metal: 0.5 }));
  stem.position.y = 0.7;
  const trimMat = std(color, { emissive: color, emissiveIntensity: face.workerLive ? 1.6 : 0.9, rough: 0.4 });
  const trim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 8, 24), trimMat);
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 1.26;
  const fullLabel = cardFaceSprite(face);
  fullLabel.position.y = 2.35;
  fullLabel.material.opacity = 0;
  const miniLabel = miniPlateSprite(face);
  miniLabel.position.y = 1.9;
  miniLabel.material.opacity = 0;
  const glow = glowSprite(color, 1.6, 0.16);
  glow.position.y = 1.28;
  base.castShadow = true;
  stem.castShadow = true;
  g.add(base, stem, trim, fullLabel, miniLabel, glow);
  return { group: g, trim: trimMat, workerLive: face.workerLive, fullLabel, miniLabel, interactableId: it.id };
}

/** District gate arch (placed and rotated by the scene to face the plaza). */
export function buildGate(zone: ZoneDef): THREE.Group {
  const g = new THREE.Group();
  const color = STATUS_COLORS[zone.status];
  const pylonGeo = new THREE.BoxGeometry(0.28, 3.2, 0.28);
  const pylonMat = std(NIGHT.structure, { rough: 0.5, metal: 0.5 });
  const half = 2.3;
  for (const px of [-half, half]) {
    const pylon = new THREE.Mesh(pylonGeo, pylonMat);
    pylon.position.set(px, 1.6, 0);
    // Thin light strip up each pylon's inner face.
    const stripLight = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 3.0, 0.06),
      std(color, { emissive: color, emissiveIntensity: 0.9 }),
    );
    stripLight.position.set(px - Math.sign(px) * 0.18, 1.6, 0.1);
    g.add(pylon, stripLight);
  }
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(half * 2, 0.09, 0.14),
    std(color, { emissive: color, emissiveIntensity: 0.9, rough: 0.4 }),
  );
  bar.position.y = 3.25;
  const banner = bannerSprite(zone);
  banner.position.y = 4.15;
  g.add(bar, banner);
  return g;
}

/** A question beacon beside a card whose worker is waiting on the user. */
export function buildQuestionBeacon(): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.2, 6), std(NIGHT.pedestal));
  post.position.y = 0.6;
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 12, 10),
    std(0xffc94d, { emissive: 0xffc94d, emissiveIntensity: 2.2 }),
  );
  bulb.position.y = 1.35;
  bulb.name = "beacon-bulb";
  const plate = plateSprite("❓ needs you", { accent: "#ffc94d", size: 0.85 });
  plate.position.y = 1.95;
  const glow = glowSprite(0xffc94d, 1.4, 0.35);
  glow.position.y = 1.35;
  g.add(post, bulb, plate, glow);
  return g;
}

/** A PR or Linear-ticket kiosk in the intake yards — same LOD contract as
 *  card kiosks so the scene treats them identically. */
export function buildItemKiosk(it: Interactable): KioskHandle {
  const g = new THREE.Group();
  const isPr = it.kind === "github-pr";
  const color = isPr ? 0x53d7a4 : 0x8a63ff;

  if (isPr) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 1.0), std(0x2a4a3e, { rough: 0.7 }));
    crate.position.y = 0.5;
    crate.rotation.y = 0.35;
    crate.castShadow = true;
    const band = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.16, 1.05), std(color, { emissive: color, emissiveIntensity: 0.8 }));
    band.position.y = 0.5;
    band.rotation.y = 0.35;
    g.add(crate, band);
  } else {
    const crystal = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 1.5, 5),
      std(color, { emissive: 0x5a3fd0, emissiveIntensity: 0.6, rough: 0.35, metal: 0.3 }),
    );
    crystal.position.y = 0.75;
    crystal.rotation.y = 0.3;
    crystal.castShadow = true;
    g.add(crystal);
  }

  const pr = it.data?.pr;
  const ticket = it.data?.ticket;
  const fullLabel = pr ? prFaceSprite(pr) : ticketFaceSprite(ticket!);
  fullLabel.position.y = 2.15;
  fullLabel.material.opacity = 0;
  const miniLabel = pr
    ? miniItemPlate("⬡", `#${pr.number}`, "#53d7a4")
    : miniItemPlate("📋", ticket!.identifier, "#8a63ff");
  miniLabel.position.y = 1.6;
  miniLabel.material.opacity = 0;
  const glow = glowSprite(color, 1.4, 0.14);
  glow.position.y = 0.9;
  const trimMat = std(color, { emissive: color, emissiveIntensity: 0.7, rough: 0.4 });
  g.add(fullLabel, miniLabel, glow);
  return { group: g, trim: trimMat, workerLive: false, fullLabel, miniLabel, interactableId: it.id };
}

/** Always-visible aggregate badge for depots (like gate banners). */
function countBadgeSprite(icon: string, count: number, accent: string): THREE.Sprite {
  return plateSprite(`${icon} ${count}${count >= 8 ? "+" : ""}`, { accent, size: 1.2 });
}

/** Trophy row for the Done district: one golden statue per merged card this
 *  week (capped), plus a bragging plate. */
export function buildTrophyRow(count: number): THREE.Group {
  const g = new THREE.Group();
  const gold = std(0xffd166, { emissive: 0xffb84d, emissiveIntensity: 0.7, rough: 0.3, metal: 0.8 });
  const shown = Math.min(count, 8);
  for (let i = 0; i < shown; i++) {
    const x = (i - (shown - 1) / 2) * 0.9;
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.5, 8), std(NIGHT.structure, { rough: 0.6, metal: 0.4 }));
    pedestal.position.set(x, 0.25, 0);
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.26), gold);
    star.position.set(x, 0.85, 0);
    star.rotation.y = i * 0.5;
    star.castShadow = true;
    g.add(pedestal, star);
  }
  const plate = plateSprite(`🏆 ${count} shipped this week`, { accent: "#ffd166", size: 1.25 });
  plate.position.y = 2.3;
  g.add(plate);
  return g;
}

/** A "+N more" totem at a district's outer edge for capped columns. */
export function buildMoreTotem(moreCount: number, color: number): THREE.Group {
  const g = new THREE.Group();
  const obelisk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.34, 1.9, 4),
    std(NIGHT.structure, { rough: 0.6, metal: 0.4 }),
  );
  obelisk.position.y = 0.95;
  obelisk.castShadow = true;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.4, 4), std(color, { emissive: color, emissiveIntensity: 1.1 }));
  tip.position.y = 2.1;
  const plate = plateSprite(`+${moreCount} more`, { accent: `#${color.toString(16).padStart(6, "0")}`, size: 0.9 });
  plate.position.y = 2.75;
  g.add(obelisk, tip, plate);
  return g;
}

/** Landmarks, portals, depots, and sample items, keyed by interactable kind. */
export function buildStructure(it: Interactable): THREE.Group {
  const g = new THREE.Group();
  const add = (mesh: THREE.Mesh) => { mesh.castShadow = true; g.add(mesh); };
  const plateY = { y: 3.4, accent: undefined as string | undefined };

  switch (it.kind) {
    case "workspace": { // portal arch
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(1.35, 0.16, 10, 28),
        std(0x53d7a4, { emissive: 0x53d7a4, emissiveIntensity: 1.1, rough: 0.35, metal: 0.4 }),
      );
      arch.position.y = 1.5;
      arch.name = "portal-arch";
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(1.15, 28),
        new THREE.MeshBasicMaterial({ color: 0x123a30, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      );
      disc.position.y = 1.5;
      g.add(arch, disc);
      const glow = glowSprite(0x53d7a4, 2.6, 0.2);
      glow.position.y = 1.5;
      g.add(glow);
      plateY.y = 3.3;
      plateY.accent = "#53d7a4";
      break;
    }
    case "pr-depot": { // stacked crates + always-on count banner
      const crateMat = std(0x2a4a3e, { rough: 0.7 });
      const band = std(0x53d7a4, { emissive: 0x53d7a4, emissiveIntensity: 0.8 });
      for (const [dx, dy, dz, r] of [[-0.6, 0.7, 0, 0.3], [0.7, 0.7, 0.3, -0.2], [0, 1.9, 0.1, 0.5]] as const) {
        const crate = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.35, 1.35), crateMat);
        crate.position.set(dx, dy, dz);
        crate.rotation.y = r;
        const strip = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.18, 1.4), band);
        strip.position.set(dx, dy, dz);
        strip.rotation.y = r;
        add(crate); g.add(strip);
      }
      const count = countBadgeSprite("⬡", it.data?.prs?.length ?? 0, "#53d7a4");
      count.position.y = 3.6;
      g.add(count);
      const glow = glowSprite(0x53d7a4, 2.4, 0.18);
      glow.position.y = 1.4;
      g.add(glow);
      plateY.y = 4.5;
      plateY.accent = "#53d7a4";
      break;
    }
    case "linear-depot": { // crystal cluster + loud status-filter banner
      const crystalMat = std(0x8a63ff, { emissive: 0x5a3fd0, emissiveIntensity: 0.6, rough: 0.35, metal: 0.3 });
      for (const [dx, dz, h, r] of [[0, 0, 2.6, 0.2], [-0.75, 0.35, 1.7, -0.4], [0.7, -0.2, 1.3, 0.7]] as const) {
        const crystal = new THREE.Mesh(new THREE.ConeGeometry(0.45, h, 5), crystalMat);
        crystal.position.set(dx, h / 2, dz);
        crystal.rotation.y = r;
        add(crystal);
      }
      // Shout WHICH status the yard is showing, gate-banner style.
      const filter = it.data?.ticketFilters?.find((f) => f.label === it.data?.ticketFilter);
      const count = plateSprite(
        `📋 ${(filter?.label ?? it.data?.ticketFilter ?? "").toUpperCase()} · ${filter?.count ?? it.data?.tickets?.length ?? 0}`,
        { accent: "#8a63ff", size: 1.5 },
      );
      count.position.y = 3.7;
      g.add(count);
      const glow = glowSprite(0x8a63ff, 2.4, 0.18);
      glow.position.y = 1.4;
      g.add(glow);
      plateY.y = 4.5;
      plateY.accent = "#8a63ff";
      break;
    }
    default:
      break;
  }

  const plate = plateSprite(it.label, { accent: plateY.accent });
  plate.position.y = plateY.y;
  plate.name = "structure-plate";
  g.add(plate);
  return g;
}
