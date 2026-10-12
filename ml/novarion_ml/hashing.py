"""Platform-independent provenance hashes for text files (D-020).

A git checkout on Windows may write CRLF where Linux writes LF, so hashing raw bytes would give the same commit
different config / split / bundle hashes on different machines. Text provenance hashes are therefore taken over
LF-normalized content (identical to the raw hash for LF files, so existing hashes are unchanged). Binary data
(the source spreadsheet, model artifacts) is still hashed byte for byte.
"""

from __future__ import annotations

import hashlib
from pathlib import Path


def normalized_text_bytes(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n")


def text_sha256(path: Path) -> str:
    return hashlib.sha256(normalized_text_bytes(path.read_bytes())).hexdigest()
