// The 3D heart (plan §9). One store drives everything: a 3D click and a panel click both call selectTarget().
import { CameraControls, useGLTF } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import type { DisplayAnalysis, Meta, TargetId } from "../api/client";
import { useStore } from "../store/useStore";
import type { SceneState } from "./sceneState";
import { MYOCARDIUM_LINEAR, NEUTRAL_LINEAR, oklchToLinearSrgb, vesselColor, type ColorTransfer } from "./colors";

import { MODEL_URL } from "./modelUrl";
export { MODEL_URL };
export const LABELLED_TARGETS = ["lad", "lcx", "rca"] as const satisfies readonly TargetId[];
const VESSEL_NODES = ["vessel_lad", "vessel_lcx", "vessel_rca", "vessel_lm"] as const;
const CONTEXT_NODES = ["torso_shell", "rib_cage"] as const; // translucent body context, never pickable
const KNOWN_NODES = new Set<string>([...VESSEL_NODES, "heart_myocardium", ...CONTEXT_NODES]);
const ISOLATED_OPACITY = 0.15;
const SCRATCH = new THREE.Vector3(); // reused per frame for label projection (no per-frame allocation)

export interface AnatomyMap {
  targets: Record<TargetId, { nodes: string[]; label: string; camera_preset: string; label_anchor?: number[] }>;
  non_target_nodes: Record<string, { label: string; message: string }>;
  click_behavior: Record<string, string>;
  camera_presets: Record<string, { position: number[]; target: number[]; up: number[]; fov: number }>;
  view_presets?: { id: string; label: string }[];
  context_nodes?: Record<string, { label: string; opacity: number; color_oklch: [number, number, number] }>;
  color_transfer: ColorTransfer;
}

/** Called each rendered frame with a label's screen position; the DOM labels live in HeartView (no extra React roots). */
export type PlaceLabel = (target: TargetId, x: number, y: number, visible: boolean) => void;

function SceneFallback() {
  return (
    <div role="status" className="flex h-full items-center justify-center p-8 text-center text-sm text-slate-600">
      <div>
        <p className="font-semibold">3D view unavailable.</p>
        <p>Use the target controls and prediction panels. Reload to retry the 3D view.</p>
      </div>
    </div>
  );
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <SceneFallback /> : this.props.children; }
}

export function nodeToTarget(map: AnatomyMap): Record<string, TargetId> {
  const out: Record<string, TargetId> = {};
  for (const [target, spec] of Object.entries(map.targets)) for (const node of spec.nodes) out[node] = target as TargetId;
  return out;
}

function nodeName(object: THREE.Object3D | null): string | null {
  for (let o = object; o; o = o.parent) if (KNOWN_NODES.has(o.name)) return o.name;
  return null;
}

/** A point ON the vessel: the vertex nearest to the centre of the world-space bounding box. */
function surfaceAnchor(mesh: THREE.Mesh): THREE.Vector3 {
  const centre = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
  const positions = mesh.geometry.getAttribute("position");
  const v = new THREE.Vector3();
  const best = new THREE.Vector3();
  let bestDistance = Infinity;
  for (let k = 0; k < positions.count; k++) {
    v.fromBufferAttribute(positions, k).applyMatrix4(mesh.matrixWorld);
    const d = v.distanceToSquared(centre);
    if (d < bestDistance) {
      bestDistance = d;
      best.copy(v);
    }
  }
  return best;
}

/** MeshStandardMaterial + an optional faint stripe pattern (outside the qualified ranges, plan §9.3, D-024) driven by `uHatch`. */
function makeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.0, transparent: true });
  const uniforms = { uHatch: { value: 0 } };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHatch = uniforms.uHatch;
    const lines = (...l: string[]) => l.join("\n");
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", lines("#include <common>", "varying vec3 vNovWorld;"))
      .replace("#include <worldpos_vertex>",
        lines("#include <worldpos_vertex>", "vNovWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;"));
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", lines("#include <common>", "uniform float uHatch;", "varying vec3 vNovWorld;"))
      .replace("#include <color_fragment>", lines(
        "#include <color_fragment>",
        "if (uHatch > 0.5) {",
        "  float stripe = step(0.55, fract((vNovWorld.x + vNovWorld.y - vNovWorld.z) * 45.0));",
        "  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), stripe * 0.12);", // faint: a tier, not a warning (D-024)
        "}",
      ));
  };
  return material;
}

function setOpacity(object: THREE.Object3D | undefined, opacity: number): void {
  const material = (object as THREE.Mesh | undefined)?.material as THREE.Material | undefined;
  if (material) material.opacity = opacity;
}

// Body context fades with camera distance: full context when zoomed out ("where in the body"), nearly invisible
// in vessel close-ups so ribs and skin never wash out the vessel colours.
const CONTEXT_FADE = { near: 3.2, far: 7.0, minFactor: 0.12 };

function setVisible(object: THREE.Object3D | undefined, visible: boolean): void {
  if (object) object.visible = visible;
}

function setHatch(material: THREE.Material, on: boolean): void {
  (material.userData.uniforms as { uHatch: { value: number } }).uHatch.value = on ? 1 : 0;
}

/** Final material state for a snapshot: colours jump to their targets (t = 0, no mid-animation frames). */
function settleColours(meshes: Record<string, THREE.Mesh>, goals: Map<string, THREE.Color>): void {
  for (const [name, goal] of goals) (meshes[name]?.material as THREE.MeshStandardMaterial | undefined)?.color.copy(goal);
}

function pixelsToPng(pixels: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(width, height);
  for (let row = 0; row < height; row++) { // WebGL rows are bottom-up
    image.data.set(pixels.subarray((height - 1 - row) * width * 4, (height - row) * width * 4), row * width * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

const SNAPSHOT_SIZE = { width: 1600, height: 1000 };

const RECOLOUR_TAU_S = 0.15; // exponential ease: ~600 ms to settle (plan §9.2 state 2)

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function HeartModel({ map, analysis, placeLabel, sceneState }: {
  map: AnatomyMap; analysis: DisplayAnalysis | null; placeLabel: PlaceLabel; sceneState: SceneState;
}) {
  const { scene } = useGLTF(MODEL_URL);
  const invalidate = useThree((s) => s.invalidate);
  const selectedTarget = sceneState.selected;
  const anatomy = sceneState.kind === "anatomy";
  const isolation = useStore((s) => s.isolation);
  const hoverNode = sceneState.hover?.node ?? null;
  const showBody = useStore((s) => s.showBody);
  const nodeTarget = useMemo(() => nodeToTarget(map), [map]);

  // One material per named node, created once.
  const meshes = useMemo(() => {
    const found: Record<string, THREE.Mesh> = {};
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      const name = nodeName(o);
      if (name && (o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        const context = map.context_nodes?.[name];
        if (context) {
          // Glass-like body context: transparent, both faces, drawn after the heart, invisible to the pointer.
          mesh.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color().setRGB(...oklchToLinearSrgb(context.color_oklch), THREE.LinearSRGBColorSpace),
            transparent: true, opacity: context.opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.4,
          });
          mesh.renderOrder = name === "torso_shell" ? 3 : 2;
          mesh.raycast = () => undefined;
        } else {
          mesh.material = makeMaterial();
        }
        found[name] = mesh;
      }
    });
    return found;
  }, [scene, map]);

  useEffect(() => {
    for (const name of CONTEXT_NODES) setVisible(meshes[name], showBody);
    invalidate();
  }, [meshes, showBody, invalidate]);

  const anchors = useMemo(() => {
    const out: [TargetId, THREE.Vector3][] = [];
    for (const target of LABELLED_TARGETS) {
      const pinned = map.targets[target].label_anchor; // computed offline: visible from the target's own preset
      const mesh = meshes[map.targets[target].nodes[0] ?? ""];
      if (pinned) out.push([target, new THREE.Vector3(...(pinned as [number, number, number]))]);
      else if (mesh) out.push([target, surfaceAnchor(mesh)]);
    }
    return out;
  }, [meshes, map]);

  // Target colours per node; the frame loop eases materials toward them. Animation never changes state.
  const targetColours = useRef(new Map<string, THREE.Color>());

  // Colour + isolation, applied as a pure function of (analysis, selection).
  useEffect(() => {
    const instant = prefersReducedMotion();
    const vesselSelected = selectedTarget !== null && selectedTarget !== "cad";
    for (const [name, mesh] of Object.entries(meshes)) {
      if (map.context_nodes?.[name]) continue; // context nodes keep their own fixed glass material
      const material = mesh.material as THREE.MeshStandardMaterial;
      const target = nodeTarget[name];
      const prediction = target ? analysis?.targets[target] : undefined;
      let rgb = name === "heart_myocardium" ? MYOCARDIUM_LINEAR : NEUTRAL_LINEAR;
      if (prediction && target !== "cad") {
        rgb = vesselColor(
          map.color_transfer, prediction.probability, prediction.operating_threshold,
          prediction.model_confidence === "low",
        ).linear;
      }
      const goal = new THREE.Color().setRGB(...rgb, THREE.LinearSRGBColorSpace);
      targetColours.current.set(name, goal);
      if (instant) material.color.copy(goal);
      setHatch(material, !!prediction && target !== "cad" && prediction.model_confidence === "low");
      const highlighted = name === hoverNode || (target !== undefined && target === selectedTarget);
      const glow = highlighted ? 0.06 : 0;
      material.emissive.setRGB(glow, glow, glow);
      let opacity = 1;
      // Isolation needs something to inspect: a case analysis, or the anatomy page, where the vessel itself is the point.
      if (isolation && vesselSelected && (analysis || anatomy)) {
        if (name === "heart_myocardium") opacity = 0.35;
        else if (target !== selectedTarget) opacity = ISOLATED_OPACITY;
      }
      material.opacity = opacity;
      material.depthWrite = opacity === 1;
      mesh.renderOrder = name === "heart_myocardium" ? 0 : 1;
    }
    invalidate();
  }, [meshes, analysis, selectedTarget, anatomy, isolation, hoverNode, nodeTarget, map, invalidate]);

  // Register the off-screen snapshot renderer (plan §12A.6): fixed preset camera, final colours, own render target.
  const gl = useThree((s) => s.gl);
  const sceneRoot = useThree((s) => s.scene);
  useEffect(() => {
    if (anatomy) return; // only the open case's heart renders Review Snapshots
    const render = (presetName: string) => {
      const preset = map.camera_presets[presetName] ?? map.camera_presets.overview!;
      const { width, height } = SNAPSHOT_SIZE;
      const camera = new THREE.PerspectiveCamera(preset.fov, width / height, 0.01, 50);
      const [px, py, pz] = preset.position as [number, number, number];
      const [tx, ty, tz] = preset.target as [number, number, number];
      camera.position.set(px, py, pz);
      camera.up.set(...(preset.up as [number, number, number]));
      camera.lookAt(tx, ty, tz);
      settleColours(meshes, targetColours.current);
      const target = new THREE.WebGLRenderTarget(width, height, { samples: 4 });
      target.texture.colorSpace = THREE.SRGBColorSpace;
      gl.setRenderTarget(target);
      gl.render(sceneRoot, camera);
      const pixels = new Uint8Array(width * height * 4);
      gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      gl.setRenderTarget(null);
      target.dispose();
      return {
        png_data_url: pixelsToPng(pixels, width, height),
        camera: { preset: presetName, position: preset.position, target: preset.target, up: preset.up, fov: preset.fov,
                  near: 0.01, far: 50, projection: "perspective" },
      };
    };
    useStore.getState().setSnapshotRenderer(render);
    return () => useStore.getState().setSnapshotRenderer(null);
  }, [gl, sceneRoot, map, meshes, anatomy]);

  // Project label anchors to screen space on every rendered frame (frameloop="demand": only when something moved).
  useFrame(({ camera, size, invalidate: requestFrame }, delta) => {
    const distance = camera.position.length();
    const t = Math.min(1, Math.max(0, (distance - CONTEXT_FADE.near) / (CONTEXT_FADE.far - CONTEXT_FADE.near)));
    const factor = CONTEXT_FADE.minFactor + (1 - CONTEXT_FADE.minFactor) * t * t * (3 - 2 * t); // smoothstep
    for (const name of CONTEXT_NODES) {
      const base = map.context_nodes?.[name]?.opacity;
      if (base != null) setOpacity(meshes[name], base * factor);
    }
    const alpha = 1 - Math.exp(-Math.min(delta, 0.1) / RECOLOUR_TAU_S);
    let moving = false;
    for (const [name, goal] of targetColours.current) {
      const colour = (meshes[name]?.material as THREE.MeshStandardMaterial | undefined)?.color;
      if (!colour || colour.equals(goal)) continue;
      colour.lerp(goal, alpha);
      if (Math.abs(colour.r - goal.r) + Math.abs(colour.g - goal.g) + Math.abs(colour.b - goal.b) < 1e-3) colour.copy(goal);
      else moving = true;
    }
    if (moving) requestFrame();
    for (const [target, anchor] of anchors) {
      const projected = SCRATCH.copy(anchor).project(camera);
      placeLabel(target, ((projected.x + 1) / 2) * size.width, ((1 - projected.y) / 2) * size.height, projected.z < 1);
    }
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const name = nodeName(e.object);
    const action = (name && map.click_behavior[name]) || "select:null";
    const [kind, arg] = action.split(":");
    if (kind === "select") sceneState.select(arg === "null" ? null : (arg as TargetId));
    else if (kind === "info" && arg) sceneState.showNotice(map.non_target_nodes[arg]?.message ?? null);
  };

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const name = nodeName(e.object);
    const host = (e.nativeEvent.target as HTMLElement).getBoundingClientRect();
    if (name) sceneState.setHover({ node: name, x: e.nativeEvent.clientX - host.left, y: e.nativeEvent.clientY - host.top });
  };

  return (
    <primitive object={scene} onClick={onClick} onPointerMove={onMove} onPointerOut={() => sceneState.setHover(null)} />
  );
}

function CameraRig({ map, sceneState }: { map: AnatomyMap; sceneState: SceneState }) {
  const controls = useRef<CameraControls>(null);
  const selectedTarget = sceneState.selected;
  const viewPreset = sceneState.viewPreset;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  // Deterministic: (target, view) → exactly one preset; camera position is never free state (plan §11A).
  const presetName = viewPreset ?? (selectedTarget ? map.targets[selectedTarget].camera_preset : "overview");

  useEffect(() => {
    const preset = map.camera_presets[presetName] ?? map.camera_presets.overview;
    if (!controls.current || !preset) return;
    const target = new THREE.Vector3(...(preset.target as [number, number, number]));
    const offset = new THREE.Vector3(...(preset.position as [number, number, number])).sub(target);
    // Presets are framed for a landscape canvas; back off on narrow canvases so the heart is never cropped.
    offset.multiplyScalar(Math.max(1, 1 / aspect));
    const position = target.clone().add(offset);
    void controls.current.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, !prefersReducedMotion());
  }, [presetName, map, aspect]);

  return <CameraControls ref={controls} makeDefault minDistance={0.9} maxDistance={12} smoothTime={0.45} />;
}

export function HeartScene({ meta, analysis, placeLabel, onContextLost, sceneState }: {
  meta: Meta; analysis: DisplayAnalysis | null; placeLabel: PlaceLabel; onContextLost?: () => void; sceneState: SceneState;
}) {
  const map = meta.anatomy_map as unknown as AnatomyMap;
  const overview = map.camera_presets.overview!;
  return (
    <SceneBoundary>
    <Canvas
      fallback={<SceneFallback />}
      frameloop="demand"
      dpr={[1, 1.5]}
      camera={{ position: overview.position as [number, number, number], fov: overview.fov, near: 0.01, far: 50 }}
      gl={{ antialias: true }} // no global preserveDrawingBuffer: snapshots use their own render target
      onPointerMissed={() => sceneState.select(null)}
      onCreated={({ gl }) => {
        // GPU reset / driver crash / memory pressure: tell the user instead of leaving a frozen or blank canvas
        gl.domElement.addEventListener("webglcontextlost", (event) => {
          event.preventDefault();
          onContextLost?.();
        });
      }}
      role="img" // pointer-only 3D; keyboard and screen-reader users select through the buttons above
      aria-label="Interactive 3D heart. Use the target buttons above for keyboard selection."
    >
      <color attach="background" args={["#f4f5f7"]} />
      <hemisphereLight args={["#ffffff", "#b9c0cc", 1.1]} />
      <directionalLight position={[2, 3, 4]} intensity={1.6} />
      <directionalLight position={[-3, -1, -2]} intensity={0.5} />
      <Suspense fallback={null}>
        <HeartModel map={map} analysis={analysis} placeLabel={placeLabel} sceneState={sceneState} />
      </Suspense>
      <CameraRig map={map} sceneState={sceneState} />
    </Canvas>
    </SceneBoundary>
  );
}

useGLTF.preload(MODEL_URL);
