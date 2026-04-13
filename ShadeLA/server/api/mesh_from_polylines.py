from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException

from server.analysis.mesh_from_polylines import Polyline, mesh_from_polylines


router = APIRouter(prefix="/analysis", tags=["analysis"])


def _normalize_polyline_any(obj: Any) -> list[list[float]] | None:
    """Return a polyline as list of [x,y,z] points.

    Accepts:
      - [[x,y,z], ...]
      - [[x,z], ...] (y assumed 0)
    Does not require closure; closure is handled by later stages.
    """

    try:
        arr = np.asarray(obj, dtype=np.float64)
    except Exception:
        return None

    if arr.ndim != 2:
        return None
    if arr.shape[0] < 2:
        return None

    if arr.shape[1] == 2:
        xyz = np.column_stack([arr[:, 0], np.zeros((arr.shape[0],), dtype=np.float64), arr[:, 1]])
    elif arr.shape[1] >= 3:
        xyz = arr[:, :3]
    else:
        return None

    return xyz.tolist()


def _auto_close(poly: list[list[float]]) -> list[list[float]]:
    if not poly:
        return poly
    a = np.asarray(poly[0], dtype=np.float64)
    b = np.asarray(poly[-1], dtype=np.float64)
    if np.linalg.norm(a - b) <= 1e-9:
        return poly
    return [*poly, poly[0]]


def _build_loops_from_segments(segments: list[list[list[float]]], tol: float = 1e-6) -> list[list[list[float]]]:
    """Join 2-point segments into closed loops.

    Assumes segments form one or more disjoint simple cycles (no branching).
    """

    if not segments:
        return []

    def key_xz(pt: list[float]) -> tuple[int, int]:
        # IMPORTANT: snap endpoints in XZ only.
        # When segments are drawn on terrain, the same logical endpoint can have tiny Y differences,
        # which would prevent joining if we keyed on full XYZ.
        x, z = (float(pt[0]), float(pt[2]))
        s = 1.0 / float(tol)
        return (int(round(x * s)), int(round(z * s)))

    # adjacency: node -> list of (neighbor_node, segment_index)
    nodes: dict[tuple[int, int], list[tuple[tuple[int, int], int]]] = {}
    seg_nodes: list[tuple[tuple[int, int], tuple[int, int]]] = []

    for i, seg in enumerate(segments):
        if len(seg) < 2:
            continue
        a = seg[0]
        b = seg[-1]
        ka = key_xz(a)
        kb = key_xz(b)
        seg_nodes.append((ka, kb))
        nodes.setdefault(ka, []).append((kb, i))
        nodes.setdefault(kb, []).append((ka, i))

    # quick validation: cycles should have degree 2 at every used node
    used_nodes = {k for pair in seg_nodes for k in pair}
    bad = [k for k in used_nodes if len(nodes.get(k, [])) != 2]
    if bad:
        raise ValueError(
            "Segments do not form simple closed loops (found nodes with degree != 2). "
            "Draw closed boundaries or use reconstruct_mode='hull'."
        )

    # reconstruct cycles
    seg_used = set()
    loops: list[list[list[float]]] = []

    # map node key back to a representative point
    rep: dict[tuple[int, int], list[float]] = {}
    for seg in segments:
        for p in (seg[0], seg[-1]):
            # Use y=0 here because the mesh builder uses XZ for plan geometry,
            # and boundary elevation is handled separately via the `y` parameter.
            rep.setdefault(key_xz(p), [float(p[0]), 0.0, float(p[2])])

    for si, (ka0, kb0) in enumerate(seg_nodes):
        if si in seg_used:
            continue

        # start walking
        path_keys = [ka0]
        current = ka0
        prev = None
        while True:
            neighs = nodes[current]
            # choose next that isn't prev
            if prev is None:
                nxt, use_seg = neighs[0]
            else:
                nxt, use_seg = neighs[0] if neighs[0][0] != prev else neighs[1]

            seg_used.add(use_seg)
            prev, current = current, nxt
            if current == path_keys[0]:
                break
            path_keys.append(current)

            # safety: avoid infinite
            if len(path_keys) > len(seg_nodes) + 5:
                raise ValueError("Failed to build loop from segments")

        loop = [rep[k] for k in path_keys]
        loop = _auto_close(loop)
        loops.append(loop)

    return loops


def _convex_hull_2d(points: np.ndarray) -> np.ndarray:
    """Monotonic chain convex hull. points: (N,2). Returns hull (H,2) without repeating first/last."""

    pts = np.asarray(points, dtype=np.float64)
    if len(pts) < 3:
        return pts
    # unique
    pts = np.unique(pts, axis=0)
    if len(pts) < 3:
        return pts
    pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in pts[::-1]:
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    hull = np.vstack([lower[:-1], upper[:-1]])
    return hull


def _segments_to_pointcloud_xz(segments: list[list[list[float]]]) -> np.ndarray:
    pts = []
    for seg in segments:
        if not seg:
            continue
        pts.append([float(seg[0][0]), float(seg[0][2])])
        pts.append([float(seg[-1][0]), float(seg[-1][2])])
    if not pts:
        return np.zeros((0, 2), dtype=np.float64)
    return np.asarray(pts, dtype=np.float64)


def _ccw(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    return float((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))


def _segments_intersect(p1, p2, q1, q2) -> bool:
    # strict-ish segment intersection in 2D
    p1 = np.asarray(p1, dtype=np.float64)
    p2 = np.asarray(p2, dtype=np.float64)
    q1 = np.asarray(q1, dtype=np.float64)
    q2 = np.asarray(q2, dtype=np.float64)

    def on_segment(a, b, c):
        # c on ab
        if min(a[0], b[0]) - 1e-12 <= c[0] <= max(a[0], b[0]) + 1e-12 and min(a[1], b[1]) - 1e-12 <= c[1] <= max(a[1], b[1]) + 1e-12:
            return abs(_ccw(a, b, c)) <= 1e-12
        return False

    d1 = _ccw(p1, p2, q1)
    d2 = _ccw(p1, p2, q2)
    d3 = _ccw(q1, q2, p1)
    d4 = _ccw(q1, q2, p2)

    if (d1 > 0 and d2 < 0 or d1 < 0 and d2 > 0) and (d3 > 0 and d4 < 0 or d3 < 0 and d4 > 0):
        return True
    if abs(d1) <= 1e-12 and on_segment(p1, p2, q1):
        return True
    if abs(d2) <= 1e-12 and on_segment(p1, p2, q2):
        return True
    if abs(d3) <= 1e-12 and on_segment(q1, q2, p1):
        return True
    if abs(d4) <= 1e-12 and on_segment(q1, q2, p2):
        return True
    return False


def _concave_hull_knn(points: np.ndarray, k: int = 10) -> np.ndarray:
    """KNN concave hull (alpha-like) without external deps.

    Returns hull vertices (H,2) without repeated last.
    Falls back to convex hull if it fails.
    """

    pts = np.asarray(points, dtype=np.float64)
    pts = np.unique(pts, axis=0)
    if len(pts) < 3:
        return pts
    k = int(max(3, min(k, len(pts) - 1)))

    start_idx = int(np.lexsort((pts[:, 0], pts[:, 1]))[0])
    start = pts[start_idx]
    hull = [start]
    current = start
    prev_dir = np.array([1.0, 0.0], dtype=np.float64)

    unused = pts.tolist()
    unused.remove([float(start[0]), float(start[1])])

    def angle_between(u, v):
        # return angle 0..2pi from u to v (ccw)
        u = u / (np.linalg.norm(u) + 1e-15)
        v = v / (np.linalg.norm(v) + 1e-15)
        ang = np.arctan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])
        if ang < 0:
            ang += 2 * np.pi
        return float(ang)

    def intersects_existing(a, b):
        if len(hull) < 2:
            return False
        # check against all edges except the adjacent last
        for i in range(len(hull) - 2):
            c = hull[i]
            d = hull[i + 1]
            if _segments_intersect(a, b, c, d):
                return True
        return False

    for _ in range(len(pts) + 5):
        if len(unused) == 0:
            break
        arr = np.asarray(unused, dtype=np.float64)
        d = np.linalg.norm(arr - current[None, :], axis=1)
        nn_idx = np.argsort(d)[:k]
        candidates = arr[nn_idx]

        best = None
        best_ang = None
        for cand in candidates:
            v = cand - current
            if np.linalg.norm(v) < 1e-12:
                continue
            ang = angle_between(prev_dir, v)
            if best is None or ang < best_ang:
                if not intersects_existing(current, cand):
                    best = cand
                    best_ang = ang

        if best is None:
            # increase k progressively, otherwise fallback
            if k < len(pts) - 1:
                k = min(len(pts) - 1, k + 5)
                continue
            return _convex_hull_2d(pts)

        hull.append(best)
        prev_dir = best - current
        current = best

        # close if we can
        if len(hull) >= 4 and np.linalg.norm(current - start) <= 1e-9:
            hull = hull[:-1]
            break

        # remove used
        try:
            unused.remove([float(best[0]), float(best[1])])
        except ValueError:
            pass

        # allow closure near end
        if len(hull) >= 4 and len(unused) < 3:
            if not intersects_existing(current, start):
                hull.append(start)
                hull = hull[:-1]
                break

    if len(hull) < 3:
        return _convex_hull_2d(pts)
    return np.asarray(hull, dtype=np.float64)


def _reconstruct_boundary_from_segments(
    segments_xyz: list[list[list[float]]],
    *,
    mode: str = "concave",
    concave_k: int = 12,
) -> list[list[list[float]]]:
    """Return a single closed boundary loop in XYZ from loose segments."""

    pts_xz = _segments_to_pointcloud_xz(segments_xyz)
    if len(pts_xz) < 3:
        raise ValueError("Not enough points to build hull")

    if mode == "convex":
        hull_xz = _convex_hull_2d(pts_xz)
    else:
        hull_xz = _concave_hull_knn(pts_xz, k=concave_k)
        if len(hull_xz) < 3:
            hull_xz = _convex_hull_2d(pts_xz)

    # lift back to XYZ on constant Y=0 (mesh builder uses XZ anyway)
    loop = [[float(x), 0.0, float(z)] for x, z in hull_xz]
    loop = _auto_close(loop)
    return [loop]


@router.post("/mesh/from-polylines")
def mesh_from_user_polylines(payload: dict):
    polylines_raw = payload.get("polylines")
    if not isinstance(polylines_raw, list) or len(polylines_raw) < 1:
        raise HTTPException(status_code=400, detail="payload.polylines must be a non-empty list")

    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}

    try:
        canopy_height = float(options.get("canopy_height", 0.0) or 0.0)
        has_explicit_y = "y" in options and options.get("y") is not None
        y_absolute = bool(options.get("y_absolute", False))
        y_from_input = []

        normalized = []
        dropped = 0
        for pl in polylines_raw:
            norm = _normalize_polyline_any(pl)
            if not norm:
                dropped += 1
                continue
            # Collect Y values (meters) if present
            try:
                if len(norm) >= 1 and len(norm[0]) >= 3:
                    for p in norm:
                        y_from_input.append(float(p[1]))
            except Exception:
                pass
            normalized.append(norm)

        if len(normalized) < 1:
            raise ValueError("No valid closed polylines (need >=3 points each)")

        # Anchor boundary to input line elevation (meters). canopy_height should NOT translate the whole mesh.
        base_y = float(np.max(y_from_input)) if len(y_from_input) else 0.0

        if has_explicit_y:
            # By default, interpret `y` as an OFFSET relative to the input polyline elevation.
            # This matches the common UI expectation when drawing on terrain and sending y: 0.
            y_in = float(options.get("y") or 0.0)
            y_val = y_in if y_absolute else (base_y + y_in)
        else:
            y_val = base_y

        # If the user sends segments (2-point polylines), attempt to join them into closed loops.
        only_segments = all(len(pl) == 2 for pl in normalized)
        if only_segments:
            reconstruct_mode = str(options.get("reconstruct_mode", "auto") or "auto").lower()
            hull_mode = str(options.get("hull_mode", "concave") or "concave").lower()
            concave_k = int(options.get("concave_k", 12) or 12)
            segment_join_tolerance = float(options.get("segment_join_tolerance", 0.25) or 0.25)

            if reconstruct_mode in ("segments", "join"):
                # strict join of segments into loops (requires endpoints to match within tolerance)
                normalized = _build_loops_from_segments(normalized, tol=segment_join_tolerance)
            elif reconstruct_mode in ("hull", "boundary", "outline"):
                # hull-based reconstruction from point cloud (meters)
                normalized = _reconstruct_boundary_from_segments(normalized, mode=hull_mode, concave_k=concave_k)
            else:
                # auto: prefer true loop-building; fall back to hull if needed
                try:
                    normalized = _build_loops_from_segments(normalized, tol=segment_join_tolerance)
                except Exception:
                    try:
                        normalized = _reconstruct_boundary_from_segments(normalized, mode=hull_mode, concave_k=concave_k)
                    except Exception:
                        normalized = _reconstruct_boundary_from_segments(normalized, mode="convex", concave_k=concave_k)
        else:
            # auto-close any longer polylines (but keep 2-point ones as-is; they won't triangulate)
            normalized = [
                _auto_close(pl) if len(pl) >= 3 else pl
                for pl in normalized
                if len(pl) >= 3
            ]

        if len(normalized) < 1:
            raise ValueError("No closed loops to triangulate")

        polylines = [Polyline.from_any(pl) for pl in normalized]
        mesh = mesh_from_polylines(
            polylines,
            y=y_val,
            offset_distance=float(options.get("offset", 0.0) or 0.0),
            refine_steps=int(options.get("refine_steps", 0) or 0),
            relax_iterations=int(options.get("relax_iterations", 0) or 0),
            relax_strength=float(options.get("relax_strength", 0.35) or 0.35),
            damping=float(options.get("damping", 0.95) or 0.95),
            load=float(options.get("load", 0.0) or 0.0),
            canopy_height=canopy_height,
            edge_length_factor=float(options.get("edge_length_factor", 1.0) or 1.0),
        )
        return {"ok": True, "mesh": mesh, "metadata": {"input_count": len(polylines_raw), "used": len(normalized), "dropped": dropped}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"mesh-from-polylines failed: {e}")
