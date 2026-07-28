// Corgi controller, ported from car-personal-website's createPetController
// (src/main.ts). Owns the dog's FBX model, animation state machine, and
// WASD movement. Falls back to a box-corgi placeholder when assets are
// unavailable (offline dev, CI e2e with ?gameassets=0) so the game — and its
// tests — never depend on the 6MB model downloading.

import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clampToBounds, moveVectorFromKeys, wrapAngle, yawForMove } from "./input.ts";

const CLIP_RUN = "CorgiRun";
const CLIP_BARK = "CorgiIdleBarking";
const IDLE_POOL = ["CorgiIdle", "CorgiIdleSniff", "CorgiIdleDig", "CorgiIdleMouthClosed"];
const IDLE_MIN_DURATION = 3.5;
const IDLE_MAX_DURATION = 6.0;
// Personality: linger and the dog settles in — sit after a while, then lie
// down. Any input pops it back up.
const SIT_AFTER_S = 18;
const LAY_AFTER_S = 42;
const SCRATCH_MIN_S = 8;
const SCRATCH_MAX_S = 15;
const SPRINT_MULT = 1.6;

export const DOG_RUN_SPEED = 10.5; // world units / s
const DOG_BASE_SCALE = 0.018;
const SPEED_TAU = 0.10; // ~6 frames @60fps to reach target speed
const YAW_TAU = 0.08;   // snappier on direction swaps
const RUN_CROSSFADE = 0.4;

type AnimState = "idle" | "running" | "sitting" | "laying";

export interface DogController {
  /** The group owning world position + yaw. Add it to the scene. */
  rig: THREE.Group;
  update(dt: number, keys: ReadonlySet<string>, bounds: number): void;
  speedFraction(): number;
  /** Test/debug teleport. */
  setPosition(x: number, z: number): void;
  /** Woof. Interrupts idling/resting briefly. */
  bark(): void;
  /** Auto-run destination (fast travel / whistle); manual input cancels it. */
  setAutoTarget(point: { x: number; z: number } | null): void;
  getAutoTarget(): { x: number; z: number } | null;
  dispose(): void;
}

/** Placeholder body so the game is playable before (or without) the FBX. */
function buildPlaceholderCorgi(): THREE.Group {
  const g = new THREE.Group();
  g.name = "placeholder-corgi";
  const fur = new THREE.MeshStandardMaterial({ color: 0xd88a3c, roughness: 0.9 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf5efe4, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.75, 1.8), fur);
  body.position.y = 0.65;
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.4, 0.7), white);
  chest.position.set(0, 0.5, -0.6);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.55, 0.6), fur);
  head.position.set(0, 1.2, -1.0);
  const earGeo = new THREE.ConeGeometry(0.16, 0.35, 4);
  const earL = new THREE.Mesh(earGeo, fur);
  earL.position.set(-0.2, 1.62, -1.0);
  const earR = new THREE.Mesh(earGeo, fur);
  earR.position.set(0.2, 1.62, -1.0);
  const legGeo = new THREE.BoxGeometry(0.22, 0.35, 0.22);
  for (const [lx, lz] of [[-0.3, -0.6], [0.3, -0.6], [-0.3, 0.6], [0.3, 0.6]] as const) {
    const leg = new THREE.Mesh(legGeo, white);
    leg.position.set(lx, 0.18, lz);
    g.add(leg);
  }
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.18), white);
  tail.position.set(0, 0.85, 0.95);
  g.add(body, chest, head, earL, earR, tail);
  g.traverse((n) => { if ((n as THREE.Mesh).isMesh) n.castShadow = true; });
  return g;
}

export function createDogController(scene: THREE.Scene, opts: { loadAssets: boolean }): DogController {
  const rig = new THREE.Group();
  rig.name = "dog-rig";
  scene.add(rig);

  const placeholder = buildPlaceholderCorgi();
  rig.add(placeholder);

  let mixer: THREE.AnimationMixer | null = null;
  let disposed = false;

  // --- Animation clip management (only used once the FBX lands) ---
  const loaded = new Map<string, THREE.AnimationClip>();
  let currentAction: THREE.AnimationAction | null = null;
  let currentName: string | null = null;
  let pending: string | null = null;
  const loader = new FBXLoader();

  /** Strip root-motion translation tracks so the rig owns world position and
   *  the clip only owns the in-place pose (Mixamo-style root motion would
   *  otherwise yank the mesh away from the rig every frame). */
  function stripRootMotion(clip: THREE.AnimationClip): THREE.AnimationClip {
    clip.tracks = clip.tracks.filter((t) => !/\.position$/.test(t.name));
    return clip;
  }

  async function ensureClip(name: string): Promise<THREE.AnimationClip> {
    let clip = loaded.get(name);
    if (clip) return clip;
    const fbx = await loader.loadAsync(`/models/corgi/${name}.fbx`);
    const c = fbx.animations[0];
    if (!c) throw new Error(`dog clip ${name} has no animations`);
    c.name = name;
    stripRootMotion(c);
    loaded.set(name, c);
    return c;
  }

  function playLoaded(clip: THREE.AnimationClip, opts?: { crossfade?: number; once?: boolean }) {
    if (!mixer) return;
    const next = mixer.clipAction(clip);
    next.reset();
    if (opts?.once) {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
    }
    if (currentAction && currentAction !== next) {
      next.crossFadeFrom(currentAction, opts?.crossfade ?? 0.25, false);
    }
    next.play();
    currentAction = next;
  }

  /** Request a named clip; fetch-then-play, ignoring stale fetches. */
  function play(name: string, opts?: { crossfade?: number; once?: boolean }) {
    if (!mixer) return;
    pending = name;
    if (currentName === name && !opts?.once) return;
    currentName = name;
    const cached = loaded.get(name);
    if (cached) {
      playLoaded(cached, opts);
      return;
    }
    void ensureClip(name)
      .then((c) => { if (pending === name && !disposed) playLoaded(c, opts); })
      .catch(() => { /* placeholder pose is an acceptable fallback */ });
  }

  // --- Idle/rest/run state machine ---
  let animState: AnimState = "idle";
  let idleTimer = 0;
  let idleElapsed = 0;
  let scratchTimer = 0;
  /** Loop clip to start when the current LoopOnce transition finishes. */
  let onceThen: string | null = null;
  function pickIdle() {
    const id = IDLE_POOL[Math.floor(Math.random() * IDLE_POOL.length)]!;
    play(id);
    idleTimer = IDLE_MIN_DURATION + Math.random() * (IDLE_MAX_DURATION - IDLE_MIN_DURATION);
  }
  /** Play a transition clip once, then settle into a loop clip. */
  function playOnceThen(name: string, then: string, crossfade = 0.3) {
    onceThen = then;
    play(name, { once: true, crossfade });
  }
  function wakeUp() {
    onceThen = null;
    idleElapsed = 0;
    if (animState === "sitting" || animState === "laying") animState = "idle";
  }

  // --- FBX load (async, optional) ---
  if (opts.loadAssets) {
    const tex = new THREE.TextureLoader().load("/models/corgi/CorgiExample1.png");
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    loader
      .loadAsync("/models/corgi/CorgiCorgi.fbx")
      .then((root) => {
        if (disposed) return;
        root.scale.setScalar(DOG_BASE_SCALE);
        // FBX-original frame: head along +Z. Rotate π so the head faces -Z,
        // the rig's forward at yaw 0 — otherwise the corgi runs backwards.
        root.rotation.y = Math.PI;
        root.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh && !(mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
          mesh.castShadow = true;
          mesh.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.05 });
        });
        // Bind-pose vertices live far below y=0 (the skeleton translates them
        // back at render time); lift so the unskinned bbox sits on the ground.
        const bbox = new THREE.Box3().setFromObject(root);
        if (Number.isFinite(bbox.min.y)) root.position.y = -bbox.min.y;
        rig.remove(placeholder);
        rig.add(root);
        mixer = new THREE.AnimationMixer(root);
        if (animState === "running") play(CLIP_RUN);
        else pickIdle();
      })
      .catch(() => { /* keep placeholder */ });
  }

  // --- Movement (same smoothing constants as the source game) ---
  let displaySpeed = 0;
  let displayYaw = 0;
  const _forward = new THREE.Vector3();

  let autoTarget: { x: number; z: number } | null = null;

  return {
    rig,
    speedFraction: () => Math.abs(displaySpeed) / DOG_RUN_SPEED,
    setPosition(x: number, z: number) {
      rig.position.x = x;
      rig.position.z = z;
    },
    bark() {
      if (animState === "running" || !mixer) return;
      wakeUp();
      animState = "idle";
      playOnceThen(CLIP_BARK, IDLE_POOL[0]!, 0.15);
      idleTimer = 3;
    },
    setAutoTarget(point) {
      autoTarget = point;
      if (point) wakeUp();
    },
    getAutoTarget: () => autoTarget,
    update(dt: number, keys: ReadonlySet<string>, bounds: number) {
      // Chain LoopOnce transitions (sit-down, bark, …) into their loops.
      if (mixer && onceThen && currentAction && !currentAction.isRunning()) {
        const next = onceThen;
        onceThen = null;
        play(next, { crossfade: 0.2 });
      }
      mixer?.update(dt);

      let { dx, dz, moving } = moveVectorFromKeys(keys);
      if (moving) {
        autoTarget = null; // manual input takes the wheel
      } else if (autoTarget) {
        const tx = autoTarget.x - rig.position.x;
        const tz = autoTarget.z - rig.position.z;
        if (Math.hypot(tx, tz) < 1.1) {
          autoTarget = null;
        } else {
          dx = tx;
          dz = tz;
          moving = true;
        }
      }
      const sprinting = keys.has("ShiftLeft") || keys.has("ShiftRight");

      if (moving) {
        wakeUp();
        if (animState !== "running") {
          animState = "running";
          play(CLIP_RUN, { crossfade: RUN_CROSSFADE });
        }
        const targetYaw = yawForMove(dx, dz);
        const delta = wrapAngle(targetYaw - displayYaw);
        displayYaw += delta * (1 - Math.exp(-dt / YAW_TAU));
        rig.rotation.y = displayYaw;
      } else if (animState === "running") {
        animState = "idle";
        idleElapsed = 0;
        if (mixer) pickIdle();
      } else if (mixer) {
        idleElapsed += dt;
        if (animState === "idle") {
          idleTimer -= dt;
          if (idleElapsed >= SIT_AFTER_S) {
            animState = "sitting";
            scratchTimer = SCRATCH_MIN_S + Math.random() * (SCRATCH_MAX_S - SCRATCH_MIN_S);
            playOnceThen("CorgiIdleToSit", "CorgiSitIdle");
          } else if (idleTimer <= 0) {
            pickIdle();
          }
        } else if (animState === "sitting") {
          scratchTimer -= dt;
          if (idleElapsed >= LAY_AFTER_S) {
            animState = "laying";
            playOnceThen("CorgiSitToLay", "CorgiLayIdle");
          } else if (scratchTimer <= 0 && !onceThen) {
            scratchTimer = SCRATCH_MIN_S + Math.random() * (SCRATCH_MAX_S - SCRATCH_MIN_S);
            playOnceThen("CorgiSitScratch", "CorgiSitIdle");
          }
        }
        // laying: stays put until input wakes it.
      }

      const targetSpeed = moving ? DOG_RUN_SPEED * (sprinting ? SPRINT_MULT : 1) : 0;
      displaySpeed += (targetSpeed - displaySpeed) * (1 - Math.exp(-dt / SPEED_TAU));
      if (Math.abs(displaySpeed - targetSpeed) < 0.05) displaySpeed = targetSpeed;

      if (displaySpeed !== 0) {
        _forward.set(0, 0, -1).applyQuaternion(rig.quaternion);
        rig.position.x = clampToBounds(rig.position.x + _forward.x * displaySpeed * dt, bounds);
        rig.position.z = clampToBounds(rig.position.z + _forward.z * displaySpeed * dt, bounds);
      }
    },
    dispose() {
      disposed = true;
      mixer?.stopAllAction();
      // Free GPU resources so repeated enter/exit of dog mode stays bounded.
      rig.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh && !(mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          (m as THREE.MeshStandardMaterial).map?.dispose();
          m?.dispose();
        }
      });
      scene.remove(rig);
    },
  };
}
