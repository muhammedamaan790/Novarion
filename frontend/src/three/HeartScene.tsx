// The 3D heart (plan §9). One store drives everything: a 3D click and a panel click both call selectTarget().
import { CameraControls, useGLTF } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { DisplayAnalysis, Meta, TargetId } from "../api/client";
import { useStore } from "../store/useStore";
import { MYOCARDIUM_LINEAR, NEUTRAL_LINEAR, vesselColor, type ColorTransfer } from "./colors";

export const MODEL_URL = "/models/heart.glb";
export const LABELLED_TARGETS = ["lad", "lcx", "rca"] as const satisfies readonly TargetId[];
const VESSEL_NODES = ["vessel_lad", "vessel_lcx", "vessel_rca", "vessel_lm"] as const;
const KNOWN_NODES = new Set<string>([...VESSEL_NODES, "heart_myocardium"]);
const ISOLATED_OPACITY = 0.15;
const SCRATCH = new THREE.Vector3(); // reused per frame for label projection (no per-frame allocation)

export interface AnatomyMap {
  targets: Record<TargetId, { nodes: string[]; label: string; camera_preset: string; label_anchor?: number[] }>;
  non_target_nodes: Record<string, { label: string; message: string }>;
  click_behavior: Record<string, string>;
  camera_presets: Record<string, { position: number[]; target: number[]; up: number[]; fov: number }>;
  view_presets?: { id: string; label: string }[];
  color_transfer: ColorTransfer;
}

/** Called each rendered frame with a label's screen position; the DOM labels live in HeartView (no extra React roots). */
export type PlaceLabel = (target: TargetId, x: number, y: number, visible: boolean) => void;

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

/** MeshStandardMaterial + an optional hatch pattern (LOW model confidence, plan §9.3) driven by `uHatch`. */
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
        "  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), stripe * 0.5);",
        "}",
      ));
  };
  return material;
}

function setHatch(material: THREE.Material, on: boolean): void {
  (material.userData.uniforms as { uHatch: { value: number } }).uHatch.value = on ? 1 : 0;
}

const RECOLOUR_TAU_S = 0.15; // exponential ease: ~600 ms to settle (plan §9.2 state 2)

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function HeartModel({ map, analysis, placeLabel }: { map: AnatomyMap; analysis: DisplayAnalysis | null; placeLabel: PlaceLabel }) {
  const { scene } = useGLTF(MODEL_URL);
  const invalidate = useThree((s) => s.invalidate);
  const selectedTarget = useStore((s) => s.selectedTarget);
  const isolation = useStore((s) => s.isolation);
  const hoverNode = useStore((s) => s.hover?.node ?? null);
  const nodeTarget = useMemo(() => nodeToTarget(map), [map]);

  // One material per named node, created once.
  const meshes = useMemo(() => {
    const found: Record<string, THREE.Mesh> = {};
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      const name = nodeName(o);
      if (name && (o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        mesh.material = makeMaterial();
        found[name] = mesh;
      }
    });
    return found;
  }, [scene]);

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
      if (isolation && vesselSelected) {
        if (name === "heart_myocardium") opacity = 0.35;
        else if (target !== selectedTarget) opacity = ISOLATED_OPACITY;
      }
      material.opacity = opacity;
      material.depthWrite = opacity === 1;
      mesh.renderOrder = name === "heart_myocardium" ? 0 : 1;
    }
    invalidate();
  }, [meshes, analysis, selectedTarget, isolation, hoverNode, nodeTarget, map, invalidate]);

  // Project label anchors to screen space on every rendered frame (frameloop="demand": only when something moved).
  useFrame(({ camera, size, invalidate: requestFrame }, delta) => {
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
    const { selectTarget, showNotice } = useStore.getState();
    if (kind === "select") selectTarget(arg === "null" ? null : (arg as TargetId));
    else if (kind === "info" && arg) showNotice(map.non_target_nodes[arg]?.message ?? null);
  };

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const name = nodeName(e.object);
    const host = (e.nativeEvent.target as HTMLElement).getBoundingClientRect();
    if (name) useStore.getState().setHover({ node: name, x: e.nativeEvent.clientX - host.left, y: e.nativeEvent.clientY - host.top });
  };

  return (
    <primitive object={scene} onClick={onClick} onPointerMove={onMove} onPointerOut={() => useStore.getState().setHover(null)} />
  );
}

function CameraRig({ map }: { map: AnatomyMap }) {
  const controls = useRef<CameraControls>(null);
  const selectedTarget = useStore((s) => s.selectedTarget);
  const viewPreset = useStore((s) => s.viewPreset);
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

  return <CameraControls ref={controls} makeDefault minDistance={0.9} maxDistance={6} smoothTime={0.45} />;
}

export function HeartScene({ meta, analysis, placeLabel }: { meta: Meta; analysis: DisplayAnalysis | null; placeLabel: PlaceLabel }) {
  const map = meta.anatomy_map as unknown as AnatomyMap;
  const overview = map.camera_presets.overview!;
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.5]}
      camera={{ position: overview.position as [number, number, number], fov: overview.fov, near: 0.01, far: 50 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onPointerMissed={() => useStore.getState().selectTarget(null)}
      aria-label="Interactive 3D heart. Use the target buttons above for keyboard selection."
    >
      <color attach="background" args={["#f4f5f7"]} />
      <hemisphereLight args={["#ffffff", "#b9c0cc", 1.1]} />
      <directionalLight position={[2, 3, 4]} intensity={1.6} />
      <directionalLight position={[-3, -1, -2]} intensity={0.5} />
      <Suspense fallback={null}>
        <HeartModel map={map} analysis={analysis} placeLabel={placeLabel} />
      </Suspense>
      <CameraRig map={map} />
    </Canvas>
  );
}

useGLTF.preload(MODEL_URL);
