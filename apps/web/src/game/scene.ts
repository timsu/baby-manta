// Scene composition: renderer, camera, lighting, environment, and world sync
// from a WorldLayout. All positions come from layout.ts, all meshes from
// worldObjects.ts/props.ts, all behavior from GameCanvas.tsx.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { NIGHT, STATUS_COLORS } from "./palette.ts";
import { buildGate, buildItemKiosk, buildKiosk, buildMoreTotem, buildQuestionBeacon, buildStructure, buildTrophyRow, type KioskHandle } from "./worldObjects.ts";
import { buildGround, buildLamp, buildPine, buildRock, buildSky, buildStars, createDustSystem } from "./props.ts";
import { cardFaceSprite } from "./labels.ts";
import { STREET_HALF, STREET_START_X } from "./layout.ts";
import type { CardFace, Interactable, WorldLayout } from "./types.ts";

const CAM_MIN_DIST = 6;
const CAM_MAX_DIST = 20;

export interface GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Rebuild world meshes from a new layout snapshot. */
  syncWorld(layout: WorldLayout): void;
  /** Move the highlight ring to an interactable (or hide it). */
  highlight(it: Interactable | null, elapsed: number): void;
  /** Per-frame ambient animation (beacons, orb, dust) + camera follow. */
  tick(dt: number, elapsed: number, dog: THREE.Object3D, speedFraction: number): void;
  /** Show the carried card hovering over the dog (null to drop). */
  setCarried(face: CardFace | null): void;
  /** While carrying: brighten valid drop districts, dim invalid (null = reset). */
  setCarryTargets(valid: ReadonlySet<string> | null): void;
  /** Bark: flash mid-range labels around a point for a moment. */
  pulseLabels(x: number, z: number): void;
  /** Search beacon: a light pillar at a world point (null clears). */
  setBeacon(point: { x: number; z: number } | null): void;
  getZoom(): number;
  setZoom(d: number): void;
  /** Adjust camera distance (mouse wheel). */
  zoomBy(delta: number): void;
  resize(width: number, height: number): void;
  render(): void;
  dispose(): void;
}

function disposeGroup(g: THREE.Object3D) {
  g.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh || (node as THREE.Points).type === "Points") {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => m?.dispose());
    }
    const sprite = node as THREE.Sprite;
    if (sprite.isSprite) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
  });
}

export function createGameScene(container: HTMLElement): GameScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(NIGHT.fog, 45, 130);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 500);
  camera.position.set(0, 12, 16);
  let camDist = 12.5;

  // Post-processing: bloom makes every emissive rail/gate/crystal actually
  // glow. Threshold keeps the dark theme dark; only the bright bits bleed.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Moonlight key + cool fill + warm plaza core.
  const key = new THREE.DirectionalLight(0xbdd4ff, 1.5);
  key.position.set(35, 70, 25);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 220;
  key.shadow.camera.left = -45;
  key.shadow.camera.right = 45;
  key.shadow.camera.top = 45;
  key.shadow.camera.bottom = -45;
  key.shadow.bias = -0.0004;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x6ea8ff, 0.5);
  rim.position.set(-40, 30, -50);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0x33415e, 0x141008, 1.25));
  const warm = new THREE.PointLight(NIGHT.lampWarm, 70, 70, 1.8);
  warm.position.set(STREET_START_X - 6, 9, 0);
  scene.add(warm);

  // Follow-spot on the dog so the star of the show always reads.
  const followSpot = new THREE.SpotLight(0xfff2d8, 90, 40, 0.45, 0.85, 1.6);
  followSpot.position.set(2, 10, 3);
  scene.add(followSpot, followSpot.target);

  // Static environment (kept across world syncs).
  const env = new THREE.Group();
  env.add(buildSky(), buildStars());
  scene.add(env);
  let ground: THREE.Mesh | null = null;
  let decor: THREE.Group | null = null;

  // Dynamic world (rebuilt on each layout change).
  let world = new THREE.Group();
  scene.add(world);
  let kiosks: KioskHandle[] = [];
  let pulseNodes: THREE.Object3D[] = [];
  let zoneRails: { status: string; mat: THREE.MeshStandardMaterial }[] = [];
  let carryTargets: ReadonlySet<string> | null = null;
  let labelPulseUntil = 0;
  let labelPulseCenter = { x: 0, z: 0 };
  let beacon: THREE.Group | null = null;

  const dust = createDustSystem();
  scene.add(dust.group);

  const highlightRing = new THREE.Mesh(
    new THREE.RingGeometry(0.78, 0.98, 40),
    new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  highlightRing.rotation.x = -Math.PI / 2;
  highlightRing.position.y = 0.06;
  highlightRing.visible = false;
  scene.add(highlightRing);

  // Carried card overlay + label LOD state.
  let carriedSprite: THREE.Sprite | null = null;
  let structurePlates: { sprite: THREE.Sprite; x: number; z: number; id: string }[] = [];
  let nearestId: string | null = null;

  /** Deterministic pseudo-random for decor placement (stable across rebuilds). */
  function mulberry(seed: number) {
    let a = seed;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildDecor(bounds: number): THREE.Group {
    const g = new THREE.Group();
    const rand = mulberry(42);
    // Street lamps alternate sides along the boardwalk.
    for (let i = 0; i < 8; i++) {
      const lamp = buildLamp();
      lamp.position.set(-28 + i * 8, 0, (i % 2 === 0 ? 1 : -1) * (STREET_HALF + 0.6));
      g.add(lamp);
    }
    // Pines and rocks in the wilds beyond the plots.
    for (let i = 0; i < 30; i++) {
      const x = (rand() * 2 - 1) * bounds * 1.1;
      const z = (12 + rand() * 14) * (rand() > 0.5 ? 1 : -1);
      const obj = rand() > 0.35 ? buildPine(0.8 + rand() * 1.3) : buildRock(0.8 + rand() * 1.2);
      obj.position.set(x, 0, z);
      obj.rotation.y = rand() * Math.PI * 2;
      g.add(obj);
    }
    return g;
  }

  const _camTarget = new THREE.Vector3();
  let lastElapsed = 0;

  return {
    renderer,
    scene,
    camera,
    syncWorld(layout: WorldLayout) {
      scene.remove(world);
      disposeGroup(world);
      world = new THREE.Group();
      scene.add(world);
      kiosks = [];
      pulseNodes = [];
      structurePlates = [];
      zoneRails = [];

      if (!ground) {
        ground = buildGround(layout.bounds + 30);
        scene.add(ground);
        decor = buildDecor(layout.bounds);
        scene.add(decor);
      }

      // The boardwalk: one street west→east, lane lines on both edges.
      const streetLen = layout.bounds * 2 + 10;
      const street = new THREE.Mesh(
        new THREE.BoxGeometry(streetLen, 0.04, STREET_HALF * 2),
        new THREE.MeshStandardMaterial({ color: NIGHT.path, roughness: 1, transparent: true, opacity: 0.6 }),
      );
      street.position.y = 0.012;
      street.receiveShadow = true;
      world.add(street);
      for (const side of [-1, 1]) {
        const lane = new THREE.Mesh(
          new THREE.BoxGeometry(streetLen, 0.05, 0.12),
          new THREE.MeshStandardMaterial({ color: 0x8a93a6, emissive: 0x8a93a6, emissiveIntensity: 0.25, roughness: 0.6 }),
        );
        lane.position.set(0, 0.03, side * STREET_HALF);
        world.add(lane);
      }

      // District plots: floor, status rails around the rect, street-facing
      // gate, and a "+N" totem at the back for capped columns.
      for (const zone of layout.zones) {
        const floor = new THREE.Mesh(
          new THREE.BoxGeometry(zone.halfW * 2, 0.03, zone.halfD * 2),
          new THREE.MeshStandardMaterial({ color: NIGHT.zoneStrip, roughness: 1 }),
        );
        floor.position.set(zone.x, 0.02, zone.z);
        floor.receiveShadow = true;
        world.add(floor);

        const railColor = STATUS_COLORS[zone.status];
        const railMat = new THREE.MeshStandardMaterial({ color: railColor, emissive: railColor, emissiveIntensity: 0.55, roughness: 0.5 });
        zoneRails.push({ status: zone.status, mat: railMat });
        for (const [w, d, ox, oz] of [
          [zone.halfW * 2, 0.12, 0, -zone.halfD],
          [zone.halfW * 2, 0.12, 0, zone.halfD],
          [0.12, zone.halfD * 2, -zone.halfW, 0],
          [0.12, zone.halfD * 2, zone.halfW, 0],
        ] as const) {
          const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), railMat);
          rail.position.set(zone.x + ox, 0.06, zone.z + oz);
          world.add(rail);
        }

        const gate = buildGate(zone);
        gate.position.set(zone.x, 0, zone.z - zone.side * zone.halfD);
        world.add(gate);

        if (zone.moreCount > 0) {
          const totem = buildMoreTotem(zone.moreCount, railColor);
          totem.position.set(zone.x, 0, zone.z + zone.side * (zone.halfD - 0.6));
          world.add(totem);
        }
        if (zone.trophyCount > 0) {
          const trophies = buildTrophyRow(zone.trophyCount);
          trophies.position.set(zone.x, 0, zone.z + zone.side * (zone.halfD + 1.4));
          world.add(trophies);
        }
      }

      for (const it of layout.interactables) {
        if (it.kind === "card") {
          const kiosk = buildKiosk(it);
          kiosk.group.position.set(it.x, 0, it.z);
          kiosk.group.name = it.id;
          world.add(kiosk.group);
          kiosks.push(kiosk);
        } else if (it.kind === "github-pr" || it.kind === "linear-ticket") {
          const kiosk = buildItemKiosk(it);
          kiosk.group.position.set(it.x, 0, it.z);
          kiosk.group.name = it.id;
          world.add(kiosk.group);
          kiosks.push(kiosk);
        } else if (it.kind === "question") {
          const beacon = buildQuestionBeacon();
          beacon.position.set(it.x, 0, it.z);
          beacon.name = it.id;
          world.add(beacon);
          const bulb = beacon.getObjectByName("beacon-bulb");
          if (bulb) pulseNodes.push(bulb);
        } else {
          const structure = buildStructure(it);
          structure.position.set(it.x, 0, it.z);
          structure.name = it.id;
          world.add(structure);
          const bulb = structure.getObjectByName("beacon-bulb");
          if (bulb) pulseNodes.push(bulb);
          const plate = structure.getObjectByName("structure-plate") as THREE.Sprite | null;
          if (plate) {
            plate.material.opacity = 0;
            structurePlates.push({ sprite: plate, x: it.x, z: it.z, id: it.id });
          }
        }
      }
    },
    highlight(it: Interactable | null, elapsed: number) {
      if (!it) {
        highlightRing.visible = false;
        nearestId = null;
        return;
      }
      highlightRing.visible = true;
      highlightRing.position.x = it.x;
      highlightRing.position.z = it.z;
      const pulse = 1 + 0.07 * Math.sin(elapsed * 4.5);
      highlightRing.scale.set(pulse, pulse, 1);
      nearestId = it.id;
    },
    tick(dt: number, elapsed: number, dog: THREE.Object3D, speedFraction: number) {
      lastElapsed = elapsed;
      for (const k of kiosks) {
        if (k.workerLive) k.trim.emissiveIntensity = 1.2 + 0.7 * Math.sin(elapsed * 3.2);
      }
      for (const node of pulseNodes) {
        const mat = (node as THREE.Mesh).material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 1.6 + 1.2 * Math.sin(elapsed * 5);
      }
      const arch = world.getObjectByName("portal-arch");
      if (arch) arch.rotation.y = elapsed * 0.4;

      dust.update(dt, dog.position.x, dog.position.z, speedFraction);

      // Label LOD — the fix for "label soup" at production card counts.
      // Full holo-faces exist only near the dog (or on the current target);
      // mid-range kiosks show a small id plate; far kiosks are just lit
      // geometry. Opacities ease so labels melt in/out instead of popping.
      const lodK = 1 - Math.exp(-dt / 0.12);
      const pulsing = elapsed < labelPulseUntil;
      for (const k of kiosks) {
        const dx = k.group.position.x - dog.position.x;
        const dz = k.group.position.z - dog.position.z;
        const d = Math.hypot(dx, dz);
        const pulseD = pulsing ? Math.hypot(k.group.position.x - labelPulseCenter.x, k.group.position.z - labelPulseCenter.z) : Infinity;
        const isTarget = nearestId === k.interactableId;
        const fullTarget = isTarget || d < 6.5 ? 1 : d < 9 ? (9 - d) / 2.5 : 0;
        let miniTarget = fullTarget > 0.6 ? 0 : d < 13 ? 1 : d < 16 ? (16 - d) / 3 : 0;
        if (pulseD < 14 && fullTarget < 0.6) miniTarget = 1; // bark flash
        const fm = k.fullLabel.material;
        const mm = k.miniLabel.material;
        fm.opacity += (fullTarget - fm.opacity) * lodK;
        mm.opacity += (miniTarget - mm.opacity) * lodK;
        k.fullLabel.visible = fm.opacity > 0.03;
        k.miniLabel.visible = mm.opacity > 0.03;
      }
      // Structure nameplates only when targeted or nearly touching — the
      // shapes themselves are the wayfinding.
      for (const p of structurePlates) {
        const d = Math.hypot(p.x - dog.position.x, p.z - dog.position.z);
        const target = nearestId === p.id || d < 6 ? 1 : d < 8.5 ? (8.5 - d) / 2.5 : 0;
        const m = p.sprite.material;
        m.opacity += (target - m.opacity) * lodK;
        p.sprite.visible = m.opacity > 0.03;
      }

      if (carriedSprite) {
        carriedSprite.position.set(dog.position.x, dog.position.y + 2.7 + 0.1 * Math.sin(elapsed * 2.4), dog.position.z);
      }
      // Carry telegraph: valid drop districts breathe bright, invalid go dim.
      for (const rail of zoneRails) {
        const target = carryTargets === null ? 0.55 : carryTargets.has(rail.status) ? 1.1 + 0.35 * Math.sin(elapsed * 3.5) : 0.12;
        rail.mat.emissiveIntensity += (target - rail.mat.emissiveIntensity) * lodK;
      }
      if (beacon) {
        beacon.rotation.y = elapsed * 1.2;
        const pillar = beacon.getObjectByName("beacon-pillar") as THREE.Mesh | undefined;
        if (pillar) (pillar.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.15 * Math.sin(elapsed * 5);
      }
      // Chase camera: fixed azimuth, smoothed, wheel-zoomable.
      const k = 1 - Math.exp(-dt / 0.22);
      _camTarget.set(
        dog.position.x,
        dog.position.y + camDist * 0.82,
        dog.position.z + camDist,
      );
      camera.position.lerp(_camTarget, k);
      camera.lookAt(dog.position.x, dog.position.y + 1.2, dog.position.z - 1.5);

      key.position.set(dog.position.x + 35, 70, dog.position.z + 25);
      key.target.position.set(dog.position.x, 0, dog.position.z);
      followSpot.position.set(dog.position.x + 2, 10, dog.position.z + 3);
      followSpot.target.position.copy(dog.position);
    },
    setCarried(face: CardFace | null) {
      if (carriedSprite) {
        scene.remove(carriedSprite);
        carriedSprite.material.map?.dispose();
        carriedSprite.material.dispose();
        carriedSprite = null;
      }
      if (face) {
        carriedSprite = cardFaceSprite(face);
        carriedSprite.scale.multiplyScalar(0.55);
        carriedSprite.material.depthTest = false;
        carriedSprite.renderOrder = 998;
        scene.add(carriedSprite);
      }
    },
    setCarryTargets(valid) {
      carryTargets = valid;
    },
    pulseLabels(x: number, z: number) {
      labelPulseCenter = { x, z };
      labelPulseUntil = lastElapsed + 2.2;
    },
    setBeacon(point) {
      if (beacon) {
        scene.remove(beacon);
        disposeGroup(beacon);
        beacon = null;
      }
      if (!point) return;
      beacon = new THREE.Group();
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.7, 16, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
      );
      pillar.name = "beacon-pillar";
      pillar.position.y = 8;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.1, 0.08, 8, 32),
        new THREE.MeshStandardMaterial({ color: 0xffe27a, emissive: 0xffe27a, emissiveIntensity: 1.6 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.15;
      beacon.add(pillar, ring);
      beacon.position.set(point.x, 0, point.z);
      scene.add(beacon);
    },
    getZoom() {
      return camDist;
    },
    setZoom(d: number) {
      camDist = Math.min(CAM_MAX_DIST, Math.max(CAM_MIN_DIST, d));
    },
    zoomBy(delta: number) {
      camDist = Math.min(CAM_MAX_DIST, Math.max(CAM_MIN_DIST, camDist + delta));
    },
    resize(width: number, height: number) {
      renderer.setSize(width, height);
      composer.setSize(width, height);
      bloom.resolution.set(width, height);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    },
    render() {
      composer.render();
    },
    dispose() {
      disposeGroup(world);
      disposeGroup(env);
      if (ground) disposeGroup(ground);
      if (decor) disposeGroup(decor);
      disposeGroup(dust.group);
      if (carriedSprite) {
        carriedSprite.material.map?.dispose();
        carriedSprite.material.dispose();
      }
      if (beacon) disposeGroup(beacon);
      highlightRing.geometry.dispose();
      (highlightRing.material as THREE.Material).dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
