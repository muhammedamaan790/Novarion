"""Audit R14: the training cache is invalidated by training code or training-library changes, and only by those."""

import sys

from novarion_ml.data.registry import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import train

LOCK = """
[[package]]
name = "scikit-learn"
version = "1.9.1"

[[package]]
name = "fastapi"
version = "0.120.0"
"""


def tree(root, train_body="x = 1\n", lifecycle_body="y = 1\n"):
    for rel in train.TRAINING_CODE:
        path = root / rel if rel.endswith(".py") else root / rel / "module.py"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(train_body if "train" in rel else "z = 1\n", encoding="utf-8", newline="\n")  # LF on any OS
    other = root / "ml" / "novarion_ml" / "lifecycle" / "promote.py"
    other.parent.mkdir(parents=True, exist_ok=True)
    other.write_text(lifecycle_body, encoding="utf-8", newline="\n")
    return root


def test_training_code_changes_the_identity_and_other_code_does_not(tmp_path):
    base = train.code_identity(tree(tmp_path / "a"))
    assert train.code_identity(tree(tmp_path / "b", train_body="x = 2\n")) != base  # a training change
    assert train.code_identity(tree(tmp_path / "c", lifecycle_body="y = 2\n")) == base  # lifecycle edits: no retrain
    crlf = tree(tmp_path / "d")
    for path in crlf.rglob("*.py"):
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    assert train.code_identity(crlf) == base  # a Windows checkout of the same code


def test_training_library_versions_change_the_identity_and_others_do_not():
    base = train.dependency_identity(LOCK)
    assert train.dependency_identity(LOCK.replace('version = "1.9.1"', 'version = "1.10.0"')) != base
    assert train.dependency_identity(LOCK.replace('version = "0.120.0"', 'version = "0.121.0"')) == base


def test_the_cache_key_covers_config_code_and_libraries():
    key = train.cache_key()
    assert key != train.config_key()
    assert len(key) == 64
