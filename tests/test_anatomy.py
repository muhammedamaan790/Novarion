"""P0 anatomy correspondence tests (plan §9, Tier-1 invariant): TargetId ↔ anatomy_map ↔ GLB node ↔ manifest."""

import hashlib
import json

import pytest
import rfc8785

from novarion_ml.data.registry import ROOT, load_targets

MAP = json.loads((ROOT / "config" / "anatomy_map.json").read_text(encoding="utf-8"))
MANIFEST_FILE = ROOT / "config" / "anatomy_manifest.json"
GLB = ROOT / "frontend" / "public" / "models" / "heart.glb"


@pytest.fixture(scope="module")
def manifest_doc():
    if not MANIFEST_FILE.exists():
        pytest.skip("anatomy not built — run scripts/build_anatomy.py")
    return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def glb_nodes():
    trimesh = pytest.importorskip("trimesh")
    if not GLB.exists():
        pytest.skip("heart.glb not built")
    return set(trimesh.load(GLB).geometry)


def test_every_registry_target_resolves_to_existing_nodes(glb_nodes):
    target_ids = {t["id"] for t in load_targets()["targets"]}
    assert set(MAP["targets"]) == target_ids
    for tid, spec in MAP["targets"].items():
        assert spec["nodes"], tid
        assert set(spec["nodes"]) <= glb_nodes, f"{tid}: node missing from GLB"
        assert spec["camera_preset"] in MAP["camera_presets"], tid


def test_target_nodes_are_disjoint_and_non_targets_are_not_selectable_targets():
    owners = {}
    for tid, spec in MAP["targets"].items():
        for node in spec["nodes"]:
            assert node not in owners, f"node {node} mapped to {owners[node]} and {tid}"
            owners[node] = tid
    for node in MAP["non_target_nodes"]:
        assert node not in owners
        assert MAP["click_behavior"][node].startswith("info:")


def test_click_behavior_matches_targets():
    for tid, spec in MAP["targets"].items():
        for node in spec["nodes"]:
            assert MAP["click_behavior"][node] == f"select:{tid}"
    assert MAP["click_behavior"]["background"] == "select:null"


def test_manifest_hash_dag_is_non_circular_and_valid(manifest_doc):
    inner = manifest_doc["manifest"]
    assert "anatomy_manifest_sha256" not in inner and "anatomy_asset_sha256" not in inner
    manifest_sha = hashlib.sha256(rfc8785.dumps(inner)).hexdigest()
    assert manifest_sha == manifest_doc["anatomy_manifest_sha256"]
    asset_sha = hashlib.sha256(
        rfc8785.dumps({"glb_sha256": inner["glb_sha256"], "anatomy_manifest_sha256": manifest_sha})
    ).hexdigest()
    assert asset_sha == manifest_doc["anatomy_asset_sha256"]
    if GLB.exists():
        assert hashlib.sha256(GLB.read_bytes()).hexdigest() == inner["glb_sha256"]


def test_manifest_qa_gate(manifest_doc, glb_nodes):
    inner = manifest_doc["manifest"]
    assert inner["license"] == "CC BY 4.0" and inner["attribution"]
    assert inner["triangles_total"] <= 150_000
    nodes = {n["node"]: n for n in inner["nodes"]}
    assert set(nodes) == glb_nodes
    for n in nodes.values():
        assert n["triangles"] <= n["triangle_budget"], n["node"]
        assert n["element_files"], n["node"]
    all_files = [f for n in nodes.values() for f in n["element_files"]]
    assert len(all_files) == len(set(all_files)), "an element mesh is shared between nodes"


def test_label_anchors_lie_on_their_vessel():
    trimesh = pytest.importorskip("trimesh")
    if not GLB.exists():
        pytest.skip("heart.glb not built")
    scene = trimesh.load(GLB)
    for target in ("lad", "lcx", "rca"):
        spec = MAP["targets"][target]
        transform, geometry = scene.graph[spec["nodes"][0]]
        mesh = scene.geometry[geometry].copy()
        mesh.apply_transform(transform)
        nearest = min(sum((a - b) ** 2 for a, b in zip(v, spec["label_anchor"], strict=True)) for v in mesh.vertices)
        assert nearest ** 0.5 < 1e-3, f"{target} label_anchor is not on {spec['nodes'][0]}"
