from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


class DiskCache:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, namespace: str, key: str, suffix: str) -> Path:
        namespace_dir = self.root / namespace
        namespace_dir.mkdir(parents=True, exist_ok=True)
        return namespace_dir / f"{key}{suffix}"

    def make_key(self, payload: Any) -> str:
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def get_json(self, namespace: str, key: str) -> Any | None:
        path = self._path(namespace, key, ".json")
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def set_json(self, namespace: str, key: str, value: Any) -> Path:
        path = self._path(namespace, key, ".json")
        path.write_text(json.dumps(value, indent=2), encoding="utf-8")
        return path

    def get_bytes(self, namespace: str, key: str) -> bytes | None:
        path = self._path(namespace, key, ".bin")
        if not path.exists():
            return None
        return path.read_bytes()

    def set_bytes(self, namespace: str, key: str, value: bytes, extension: str = ".bin") -> Path:
        path = self._path(namespace, key, extension)
        path.write_bytes(value)
        return path
