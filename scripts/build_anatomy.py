"""Build the coronary anatomy asset from BodyParts3D (CC BY 4.0) — plan §9.1, 3D asset QA gate.

Resolves each anatomy node (LAD / LCX / RCA / left main / heart wall) to BodyParts3D element meshes through the
IS-A hierarchy, merges them into one named node each, decimates to the plan's triangle budget, normalizes
orientation/scale, and writes:
  frontend/public/models/heart.glb
  config/anatomy_manifest.json   (non-circular hash DAG: glb_sha256 → anatomy_manifest_sha256 → anatomy_asset_sha256)

Inputs (data/raw/bodyparts3d/, git-ignored): isa_BP3D_4.0_obj_99.zip and the three IS-A list files.
"""

from __future__ import annotations

import collections
import hashlib
import io
import json
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import fast_simplification
import numpy as np
import rfc8785
import trimesh

ROOT = Path(__file__).resolve().parents[1]
BP3D = ROOT / "data" / "raw" / "bodyparts3d"
ARCHIVE = BP3D / "isa_BP3D_4.0_obj_99.zip"
OUT_GLB = ROOT / "frontend" / "public" / "models" / "heart.glb"
OUT_MANIFEST = ROOT / "config" / "anatomy_manifest.json"

SOURCE_URL = "https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip"
LICENSE = "CC BY 4.0"
LICENSE_URL = "https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html"
ATTRIBUTION = "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"

# node -> (target_id or None, FMA concepts, triangle budget)
NODES = {
    "vessel_lad": ("lad", ["FMA74912", "FMA13921"], 8000),
    "vessel_lcx": ("lcx", ["FMA3895"], 8000),
    "vessel_rca": ("rca", ["FMA3802", "FMA66327"], 8000),
    "vessel_lm": (None, ["FMA3855"], 2000),
    "heart_myocardium": ("cad", ["FMA13256"], 80000),
}


def read_table(name: str) -> list[list[str]]:
    with (BP3D / name).open(encoding="utf-8", errors="replace") as handle:
        next(handle)
        return [line.rstrip("\r\n").split("\t") for line in handle if line.strip()]


def resolve_elements() -> tuple[dict[str, list[str]], dict[str, str]]:
    children = collections.defaultdict(set)
    for row in read_table("isa_inclusion_relation_list.txt"):
        children[row[0]].add(row[2])
    elements = collections.defaultdict(set)
    concept_names: dict[str, str] = {}
    for row in read_table("isa_element_parts.txt"):
        elements[row[0]].add(row[2])
        concept_names[row[0]] = row[1]

    def descendants(concept: str) -> set[str]:
        seen, stack = {concept}, [concept]
        while stack:
            for child in children.get(stack.pop(), ()):
                if child not in seen:
                    seen.add(child)
                    stack.append(child)
        return seen

    resolved = {}
    for node, (_, concepts, _) in NODES.items():
        files: set[str] = set()
        for concept in concepts:
            for d in descendants(concept):
                files |= elements.get(d, set())
        resolved[node] = sorted(files)
    return resolved, concept_names


def load_mesh(archive: zipfile.ZipFile, element_id: str) -> trimesh.Trimesh:
    data = archive.read(f"isa_BP3D_4.0_obj_99/{element_id}.obj")
    mesh = trimesh.load(io.BytesIO(data), file_type="obj", force="mesh", process=True)
    return mesh


def decimate(mesh: trimesh.Trimesh, budget: int) -> trimesh.Trimesh:
    if len(mesh.faces) <= budget:
        return mesh
    reduction = 1.0 - budget / len(mesh.faces)
    vertices, faces = fast_simplification.simplify(
        mesh.vertices.astype(np.float32), mesh.faces.astype(np.int64), target_reduction=reduction
    )
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=True)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    if not ARCHIVE.exists():
        print(f"ERROR: {ARCHIVE} missing — download it from {SOURCE_URL}")
        return 1
    resolved, concept_names = resolve_elements()

    # Disjointness: every element file belongs to exactly one node (TargetId correspondence).
    seen: dict[str, str] = {}
    for node, files in resolved.items():
        for fid in files:
            if fid in seen:
                print(f"ERROR: element {fid} in both {seen[fid]} and {node}")
                return 1
            seen[fid] = node

    archive_sha = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    meshes: dict[str, trimesh.Trimesh] = {}
    raw_counts: dict[str, int] = {}
    with zipfile.ZipFile(ARCHIVE) as archive:
        for node, files in resolved.items():
            parts = [load_mesh(archive, fid) for fid in files]
            merged = trimesh.util.concatenate(parts)
            raw_counts[node] = len(merged.faces)
            meshes[node] = decimate(merged, NODES[node][2])

    # Normalize: center on the heart, scale so the heart's largest extent = 1.0 (units: normalized), BP3D is in mm.
    heart = meshes["heart_myocardium"]
    center = heart.bounds.mean(axis=0)
    scale = 1.0 / float(np.max(heart.extents))
    # BodyParts3D: +Z up (superior), -Y anterior. Convert to three.js convention: +Y up, +Z toward viewer (anterior).
    to_threejs = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)
    transform = to_threejs @ trimesh.transformations.scale_matrix(scale) @ trimesh.transformations.translation_matrix(-center)

    scene = trimesh.Scene()
    node_entries = []
    for node, mesh in meshes.items():
        mesh = mesh.copy()
        mesh.apply_transform(transform)
        scene.add_geometry(mesh, node_name=node, geom_name=node)
        target_id, concepts, budget = NODES[node]
        node_entries.append({
            "node": node,
            "target_id": target_id,
            "prediction_target": target_id in {"lad", "lcx", "rca", "cad"},
            "fma_concepts": [{"id": c, "name": concept_names.get(c, "")} for c in concepts],
            "element_files": resolved[node],
            "triangles_source": raw_counts[node],
            "triangles": len(mesh.faces),
            "triangle_budget": budget,
            "bounds": [[round(float(v), 5) for v in b] for b in mesh.bounds],
            "materials": 1,
        })

    OUT_GLB.parent.mkdir(parents=True, exist_ok=True)
    glb_bytes = scene.export(file_type="glb")
    OUT_GLB.write_bytes(glb_bytes)
    glb_sha = sha256_bytes(glb_bytes)

    manifest = {
        "anatomy_version": "1.0.0",
        "source": "BodyParts3D 4.0 (IS-A tree), Database Center for Life Science",
        "source_url": SOURCE_URL,
        "source_file_sha256": archive_sha,
        "retrieval_date": datetime.now(UTC).date().isoformat(),
        "license": LICENSE,
        "license_url": LICENSE_URL,
        "attribution": ATTRIBUTION,
        "derivative_status": "modified: element meshes merged per node, decimated, re-centred, rescaled, axis-converted",
        "kind": "mesh",
        "units": "normalized (heart largest extent = 1.0); source units mm",
        "orientation": "+Y superior, +Z anterior (three.js convention); converted from BodyParts3D +Z superior, -Y anterior",
        "scale_factor_from_mm": scale,
        "glb_path": "frontend/public/models/heart.glb",
        "glb_sha256": glb_sha,
        "triangles_total": int(sum(e["triangles"] for e in node_entries)),
        "nodes": node_entries,
    }
    manifest_sha = sha256_bytes(rfc8785.dumps(manifest))
    asset_sha = sha256_bytes(rfc8785.dumps({"glb_sha256": glb_sha, "anatomy_manifest_sha256": manifest_sha}))
    OUT_MANIFEST.write_text(
        json.dumps(
            {"manifest": manifest, "anatomy_manifest_sha256": manifest_sha, "anatomy_asset_sha256": asset_sha},
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    for e in node_entries:
        print(f"{e['node']:18} files={len(e['element_files']):3d} tris {e['triangles_source']:7d} -> {e['triangles']:6d}")
    print(f"total triangles {manifest['triangles_total']}; GLB {len(glb_bytes) / 1e6:.2f} MB; sha {glb_sha[:12]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
