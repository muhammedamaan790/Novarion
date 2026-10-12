"""Compute `label_anchor` per vessel target in config/anatomy_map.json (plan §10: "label anchor" per target).

Anchor = the vessel vertex visible from that target's own camera preset (ray cast against every GLB triangle,
Möller–Trumbore in numpy), nearest to the centroid of the visible part. Re-run whenever heart.glb or a camera
preset changes. Usage: uv run --group assets python scripts/compute_label_anchors.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[1]
GLB = ROOT / "frontend" / "public" / "models" / "heart.glb"
MAP = ROOT / "config" / "anatomy_map.json"
SAMPLES_PER_VESSEL = 400


def world_mesh(scene: trimesh.Scene, node: str) -> trimesh.Trimesh:
    transform, geometry = scene.graph[node]
    mesh = scene.geometry[geometry].copy()
    mesh.apply_transform(transform)
    return mesh


def first_hit_distances(origin: np.ndarray, directions: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    v0, e1, e2 = triangles[:, 0], triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
    s = origin - v0
    out = []
    for d in directions:
        p = np.cross(d, e2)
        det = (e1 * p).sum(1)
        ok = np.abs(det) > 1e-12
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        u = (s * p).sum(1) * inv
        q = np.cross(s, e1)
        w = (q * d).sum(1) * inv
        t = (e2 * q).sum(1) * inv
        hit = ok & (u >= 0) & (w >= 0) & (u + w <= 1) & (t > 1e-6)
        out.append(t[hit].min() if hit.any() else np.inf)
    return np.array(out)


def main() -> None:
    scene = trimesh.load(GLB)
    amap = json.loads(MAP.read_text(encoding="utf-8"))
    context = set(amap.get("context_nodes", {}))  # translucent body context never hides a vessel label
    triangles = np.concatenate([world_mesh(scene, n).triangles for n in scene.graph.nodes_geometry if n not in context])
    for target in ("lad", "lcx", "rca"):
        spec = amap["targets"][target]
        camera = np.array(amap["camera_presets"][spec["camera_preset"]]["position"], float)
        vertices = world_mesh(scene, spec["nodes"][0]).vertices
        vertices = vertices[:: max(1, len(vertices) // SAMPLES_PER_VESSEL)]
        offsets = vertices - camera
        distance = np.linalg.norm(offsets, axis=1)
        visible = vertices[first_hit_distances(camera, offsets / distance[:, None], triangles) >= distance - 2e-3]
        if not len(visible):
            raise SystemExit(f"{target}: vessel not visible from its own camera preset {spec['camera_preset']}")
        anchor = visible[np.argmin(np.linalg.norm(visible - visible.mean(axis=0), axis=1))]
        spec["label_anchor"] = [round(float(x), 4) for x in anchor]
        print(f"{target}: {len(visible)}/{len(vertices)} sampled vertices visible -> {spec['label_anchor']}")
    MAP.write_text(json.dumps(amap, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
