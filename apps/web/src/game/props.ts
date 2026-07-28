// Environment: sky dome, stars, ground, paths, lamps, trees, and the dust
// system. Everything procedural — no textures shipped.

import * as THREE from "three";
import { NIGHT } from "./palette.ts";

export function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(240, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(NIGHT.skyTop) },
      horizon: { value: new THREE.Color(NIGHT.skyHorizon) },
      glow: { value: new THREE.Color(NIGHT.skyGlow) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 glow;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        vec3 c = mix(horizon, top, smoothstep(0.02, 0.55, h));
        // Thin teal glow band hugging the horizon.
        c += glow * (1.0 - smoothstep(0.0, 0.18, abs(h - 0.03))) * 0.35;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = "sky";
  return sky;
}

export function buildStars(): THREE.Points {
  const count = 700;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Upper hemisphere shell.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - Math.random() * 0.85);
    const r = 220;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 8;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xdfe6f5,
    size: 1.7,
    sizeAttenuation: false,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

function groundTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, "#232733");
  g.addColorStop(0.65, "#191c25");
  g.addColorStop(1, "#10121a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Subtle dot grid for motion parallax.
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  for (let y = 8; y < size; y += 16) {
    for (let x = 8; x < size; x += 16) {
      ctx.fillRect(x, y, 1.4, 1.4);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildGround(radius: number): THREE.Mesh {
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  return ground;
}

/** A dim path segment between two ground points (plaza spokes). */
export function buildSpoke(x1: number, z1: number, x2: number, z2: number, width = 2.2): THREE.Mesh {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.03, len),
    new THREE.MeshStandardMaterial({ color: NIGHT.path, roughness: 1, transparent: true, opacity: 0.55 }),
  );
  spoke.position.set((x1 + x2) / 2, 0.015, (z1 + z2) / 2);
  spoke.rotation.y = Math.atan2(dx, dz);
  spoke.receiveShadow = true;
  return spoke;
}

export function buildLamp(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.08, 3.1, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a2e3a, roughness: 0.6, metalness: 0.5 }),
  );
  pole.position.y = 1.55;
  pole.castShadow = true;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.19, 12, 10),
    new THREE.MeshStandardMaterial({ color: NIGHT.lampWarm, emissive: NIGHT.lampWarm, emissiveIntensity: 2.2 }),
  );
  head.position.y = 3.15;
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = glowCanvas.height = 64;
  const ctx = glowCanvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "#ffc98a");
  grad.addColorStop(1, "#ffc98a00");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(glowCanvas),
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  glow.scale.setScalar(1.4);
  glow.position.y = 3.15;
  g.add(pole, head, glow);
  return g;
}

export function buildPine(scale = 1): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12 * scale, 0.18 * scale, 0.9 * scale, 6),
    new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 0.9 }),
  );
  trunk.position.y = 0.45 * scale;
  const foliage = new THREE.MeshStandardMaterial({ color: 0x16352a, roughness: 0.95 });
  let y = 1.1 * scale;
  for (const r of [1.15, 0.85, 0.55]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r * scale, 1.0 * scale, 7), foliage);
    cone.position.y = y;
    cone.castShadow = true;
    g.add(cone);
    y += 0.62 * scale;
  }
  g.add(trunk);
  return g;
}

export function buildRock(scale = 1): THREE.Mesh {
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.45 * scale, 0),
    new THREE.MeshStandardMaterial({ color: 0x262a34, roughness: 0.95 }),
  );
  rock.position.y = 0.28 * scale;
  rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  rock.castShadow = true;
  return rock;
}

/** Pooled dust puffs kicked up while the dog sprints. */
export interface DustSystem {
  group: THREE.Group;
  update(dt: number, dogX: number, dogZ: number, speedFraction: number): void;
}

export function createDustSystem(): DustSystem {
  const POOL = 26;
  const group = new THREE.Group();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(16, 16, 2, 16, 16, 16);
  grad.addColorStop(0, "rgba(200, 205, 220, 0.7)");
  grad.addColorStop(1, "rgba(200, 205, 220, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(canvas);

  interface Puff { sprite: THREE.Sprite; life: number }
  const puffs: Puff[] = [];
  for (let i = 0; i < POOL; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
    sprite.visible = false;
    group.add(sprite);
    puffs.push({ sprite, life: 0 });
  }
  let cursor = 0;
  let spawnTimer = 0;
  const LIFETIME = 0.55;

  return {
    group,
    update(dt, dogX, dogZ, speedFraction) {
      spawnTimer -= dt;
      if (speedFraction > 0.55 && spawnTimer <= 0) {
        spawnTimer = 0.09;
        const p = puffs[cursor]!;
        cursor = (cursor + 1) % POOL;
        p.life = LIFETIME;
        p.sprite.visible = true;
        p.sprite.position.set(dogX + (Math.random() - 0.5) * 0.5, 0.12, dogZ + (Math.random() - 0.5) * 0.5);
        p.sprite.scale.setScalar(0.3 + Math.random() * 0.25);
      }
      for (const p of puffs) {
        if (!p.sprite.visible) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.sprite.visible = false;
          continue;
        }
        const t = p.life / LIFETIME;
        p.sprite.material.opacity = t * 0.55;
        p.sprite.position.y += dt * 0.55;
        p.sprite.scale.multiplyScalar(1 + dt * 1.6);
      }
    },
  };
}
