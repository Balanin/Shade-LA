from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import trimesh

try:
    import pyclipper
except Exception as e:  # pragma: no cover
    pyclipper = None
    _PYCLIPPER_IMPORT_ERROR = e
else:  # pragma: no cover
    _PYCLIPPER_IMPORT_ERROR = None

try:
    import mapbox_earcut as earcut
except Exception as e:  # pragma: no cover
    earcut = None
    _EARCUT_IMPORT_ERROR = e
else:  # pragma: no cover
    _EARCUT_IMPORT_ERROR = None


@dataclass(frozen=True)
class Polyline:
    # 2D points on the XZ plane (Y ignored/constant in this mesh builder)
    points_xz: np.ndarray  # (N,2)

    @staticmethod
    def from_any(obj: Any) -> "Polyline":
        # Accepts:
        # - [[x,z], ...]
        # - [[x,y,z], ...] => takes x,z
        arr = np.asarray(obj, dtype=np.float64)
        if arr.ndim != 2 or arr.shape[0] < 3:
            raise ValueError("Polyline must be a 2D array with at least 3 points")
        if arr.shape[1] == 2:
            xz = arr
        elif arr.shape[1] >= 3:
            xz = arr[:, [0, 2]]
        else:
            raise ValueError("Polyline points must be [x,z] or [x,y,z]")
        return Polyline(points_xz=xz)


def _is_closed(xz: np.ndarray, eps: float = 1e-8) -> bool:
    if len(xz) < 3:
        return False
    return float(np.linalg.norm(xz[0] - xz[-1])) <= eps


def _close(xz: np.ndarray) -> np.ndarray:
    if _is_closed(xz):
        return xz
    return np.vstack([xz, xz[0]])


def _signed_area(xz: np.ndarray) -> float:
    # Shoelace; accepts closed or open (we ignore last if equals first)
    pts = xz
    if len(pts) >= 2 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    x = pts[:, 0]
    y = pts[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _ensure_winding(outer: np.ndarray, holes: list[np.ndarray]) -> tuple[np.ndarray, list[np.ndarray]]:
    # Earcut convention: outer should be CCW, holes should be CW.
    outer2 = outer
    if _signed_area(outer2) < 0:
        outer2 = outer2[::-1]

    holes2: list[np.ndarray] = []
    for h in holes:
        h2 = h
        if _signed_area(h2) > 0:
            h2 = h2[::-1]
        holes2.append(h2)

    return outer2, holes2


def _offset_ring_xz(ring_xz: np.ndarray, distance: float, miter_limit: float = 2.0) -> np.ndarray:
    """Offset a closed ring on the XZ plane.

    Uses pyclipper (integer coordinates) and returns the largest resulting loop.
    """

    if pyclipper is None:  # pragma: no cover
        raise RuntimeError(f"pyclipper is required for offsetting: {_PYCLIPPER_IMPORT_ERROR}")

    if abs(distance) < 1e-12:
        return ring_xz

    pts = ring_xz
    if len(pts) >= 2 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    if len(pts) < 3:
        return ring_xz

    # Scale to ints for clipper.
    scale = 1_000_000.0
    path = [(int(round(x * scale)), int(round(z * scale))) for x, z in pts]
    co = pyclipper.PyclipperOffset(miter_limit=miter_limit)
    co.AddPath(path, pyclipper.JT_MITER, pyclipper.ET_CLOSEDPOLYGON)
    out = co.Execute(distance * scale)
    if not out:
        return ring_xz

    # Choose the loop with maximum absolute area.
    def area2(loop):
        a = 0
        n = len(loop)
        for i in range(n):
            x1, y1 = loop[i]
            x2, y2 = loop[(i + 1) % n]
            a += x1 * y2 - y1 * x2
        return a

    best = max(out, key=lambda loop: abs(area2(loop)))
    res = np.asarray([(x / scale, y / scale) for x, y in best], dtype=np.float64)
    return _close(res)


def _mesh_relax_equalize_edges(
    vertices: np.ndarray,
    faces: np.ndarray,
    fixed_mask: np.ndarray,
    iterations: int = 20,
    strength: float = 0.35,
    length_factor: float = 1.0,
) -> np.ndarray:
    """Approximate Kangaroo EdgeLengths goal.

    Keeps vertices where fixed_mask=True in place (e.g. boundary vertices) and
    iteratively adjusts interior vertices to reduce edge length variance.
    """

    v = np.asarray(vertices, dtype=np.float64).copy()
    f = np.asarray(faces, dtype=np.int64)
    n = len(v)
    if n == 0 or len(f) == 0:
        return v


def _mesh_boundary_vertex_mask(faces: np.ndarray, vertex_count: int) -> np.ndarray:
    f = np.asarray(faces, dtype=np.int64)
    if vertex_count <= 0 or len(f) == 0:
        return np.zeros((vertex_count,), dtype=bool)

    edge_count: dict[tuple[int, int], int] = {}
    for a, b, c in f:
        for i, j in ((a, b), (b, c), (c, a)):
            e = (i, j) if i < j else (j, i)
            edge_count[e] = edge_count.get(e, 0) + 1

    boundary_vertices = np.zeros((vertex_count,), dtype=bool)
    for (i, j), cnt in edge_count.items():
        if cnt == 1:
            boundary_vertices[i] = True
            boundary_vertices[j] = True

    return boundary_vertices


def _mesh_subdivide_triangles(vertices: np.ndarray, faces: np.ndarray, steps: int = 1) -> tuple[np.ndarray, np.ndarray]:
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    steps = int(max(0, steps))
    if steps == 0 or len(f) == 0:
        return v, f

    for _ in range(steps):
        v_list = v.tolist()
        midpoint_index: dict[tuple[int, int], int] = {}

        def mid(i: int, j: int) -> int:
            a, b = (i, j) if i < j else (j, i)
            key = (a, b)
            idx = midpoint_index.get(key)
            if idx is not None:
                return idx
            p = (v[a] + v[b]) * 0.5
            idx = len(v_list)
            v_list.append([float(p[0]), float(p[1]), float(p[2])])
            midpoint_index[key] = idx
            return idx

        new_faces = []
        for a, b, c in f:
            ab = mid(int(a), int(b))
            bc = mid(int(b), int(c))
            ca = mid(int(c), int(a))
            new_faces.append([int(a), ab, ca])
            new_faces.append([ab, int(b), bc])
            new_faces.append([ca, bc, int(c)])
            new_faces.append([ab, bc, ca])

        v = np.asarray(v_list, dtype=np.float64)
        f = np.asarray(new_faces, dtype=np.int64)

    return v, f


def _mesh_relax_kangaroo_like(
    vertices: np.ndarray,
    faces: np.ndarray,
    fixed_mask: np.ndarray,
    *,
    iterations: int = 50,
    damping: float = 0.95,
    edge_length_factor: float = 1.0,
    edge_strength: float = 1.0,
    load: float = 0.0,
    dt: float = 1.0,
) -> np.ndarray:
    """A small Kangaroo/BouncySolver-like mass-spring relaxation.

    - Boundary/fixed vertices are anchored.
    - Each mesh edge acts like a spring trying to reach target length.
    - A constant load pulls vertices in -Y.
    - Velocity is preserved with damping (0..1).
    """

    v = np.asarray(vertices, dtype=np.float64).copy()
    f = np.asarray(faces, dtype=np.int64)
    n = len(v)
    if n == 0 or len(f) == 0:
        return v

    iterations = int(max(0, iterations))
    damping = float(np.clip(damping, 0.0, 0.9999))
    dt = float(max(1e-6, dt))
    edge_strength = float(max(0.0, edge_strength))

    # Build unique undirected edges.
    edges_set: set[tuple[int, int]] = set()
    for a, b, c in f:
        edges_set.add((min(a, b), max(a, b)))
        edges_set.add((min(b, c), max(b, c)))
        edges_set.add((min(c, a), max(c, a)))
    edges = np.asarray(sorted(edges_set), dtype=np.int64)
    if len(edges) == 0:
        return v

    # Baseline target edge length.
    evec0 = v[edges[:, 1]] - v[edges[:, 0]]
    elen0 = np.linalg.norm(evec0, axis=1)
    base = float(np.median(elen0[elen0 > 1e-12])) if np.any(elen0 > 1e-12) else 0.0
    target = base * float(edge_length_factor)
    if target <= 0:
        return v

    vel = np.zeros_like(v)
    load_vec = np.array([0.0, -float(load), 0.0], dtype=np.float64)

    for _ in range(iterations):
        # Spring forces
        evec = v[edges[:, 1]] - v[edges[:, 0]]
        elen = np.linalg.norm(evec, axis=1)
        good = elen > 1e-12
        if not np.any(good):
            break

        dir = np.zeros_like(evec)
        dir[good] = evec[good] / elen[good][:, None]

        # Hooke-like force magnitude proportional to length error
        # Positive when too long -> pull together; negative when too short -> push apart.
        err = (elen - target)
        force_edge = -edge_strength * err[:, None] * dir

        forces = np.zeros_like(v)
        a = edges[:, 0]
        b = edges[:, 1]
        np.add.at(forces, a, -force_edge)
        np.add.at(forces, b, force_edge)

        # Load on non-fixed
        if abs(load) > 1e-12:
            forces[~fixed_mask] += load_vec

        # Integrate
        vel = damping * vel + dt * forces
        vel[fixed_mask] = 0.0
        v = v + dt * vel
        v[fixed_mask] = vertices[fixed_mask]

    return v


def triangulate_polygon_xz(
    outer: Polyline,
    holes: list[Polyline] | None = None,
    *,
    offset_distance: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Triangulate a polygon with holes on the XZ plane.

    Returns:
        vertices_xz: (V, 2)
        faces: (F, 3) indices into vertices_xz
    """

    if earcut is None:  # pragma: no cover
        raise RuntimeError(f"mapbox_earcut is required: {_EARCUT_IMPORT_ERROR}")

    holes = holes or []

    outer_xz = _close(np.asarray(outer.points_xz, dtype=np.float64))
    hole_xzs = [_close(np.asarray(h.points_xz, dtype=np.float64)) for h in holes]

    if abs(offset_distance) > 1e-12:
        outer_xz = _offset_ring_xz(outer_xz, offset_distance)
        # Offset holes in opposite direction to preserve voids.
        hole_xzs = [_offset_ring_xz(h, -offset_distance) for h in hole_xzs]

    if len(outer_xz) < 4:
        raise ValueError("Outer ring must have at least 3 vertices")

    # drop duplicated last point for earcut
    if np.allclose(outer_xz[0], outer_xz[-1]):
        outer_xz = outer_xz[:-1]
    hole_xzs2: list[np.ndarray] = []
    for h in hole_xzs:
        if len(h) < 4:
            continue
        if np.allclose(h[0], h[-1]):
            h = h[:-1]
        hole_xzs2.append(h)

    outer_xz, hole_xzs2 = _ensure_winding(outer_xz, hole_xzs2)

    verts = np.vstack([outer_xz, *hole_xzs2]) if hole_xzs2 else outer_xz
    rings = [len(outer_xz)] + [len(h) for h in hole_xzs2]

    # mapbox_earcut expects ring_end_indices (cumulative ends), including the outer ring.
    ring_end_indices = np.cumsum(rings, dtype=np.uint32)

    verts2 = np.ascontiguousarray(verts.astype(np.float64))
    idx = earcut.triangulate_float64(verts2, ring_end_indices)
    faces = np.asarray(idx, dtype=np.int64).reshape(-1, 3)
    return verts, faces


def mesh_from_polygon_xz(
    outer: Polyline,
    holes: list[Polyline] | None = None,
    y: float = 0.0,
    *,
    offset_distance: float = 0.0,
    canopy_height: float = 0.0,
    refine_steps: int = 0,
    relax_iterations: int = 0,
    relax_strength: float = 0.35,
    damping: float = 0.95,
    load: float = 0.0,
    edge_length_factor: float = 1.0,
) -> dict:
    """Build a single triangulated surface mesh (no thickness).

    Returns a JSON-serializable dict:
        {"vertices": [[x,y,z], ...], "faces": [[i,j,k], ...]}
    """

    verts_xz, faces = triangulate_polygon_xz(outer, holes=holes, offset_distance=offset_distance)
    verts = np.column_stack([verts_xz[:, 0], np.full(len(verts_xz), float(y)), verts_xz[:, 1]])

    refine_steps = int(max(0, refine_steps))
    if refine_steps > 0:
        verts, faces = _mesh_subdivide_triangles(verts, faces, steps=refine_steps)

    if relax_iterations and relax_iterations > 0:
        fixed = _mesh_boundary_vertex_mask(faces, len(verts))

        # Lift only interior vertices (boundary stays on the input lines).
        canopy_height = float(canopy_height or 0.0)
        if abs(canopy_height) > 1e-12:
            verts[~fixed, 1] = verts[~fixed, 1] + canopy_height

        # Use Kangaroo-like relaxation to produce a membrane-like canopy.
        verts = _mesh_relax_kangaroo_like(
            verts,
            faces,
            fixed_mask=fixed,
            iterations=int(relax_iterations),
            damping=float(damping),
            edge_length_factor=float(edge_length_factor),
            edge_strength=float(max(0.0, relax_strength)),
            load=float(load),
            dt=1.0,
        )

    # trimesh is optional here; we keep it for validation
    _ = trimesh.Trimesh(vertices=verts, faces=faces, process=False)

    return {
        "vertices": verts.tolist(),
        "faces": faces.tolist(),
    }


def mesh_from_polylines(
    polylines: list[Polyline],
    y: float = 0.0,
    *,
    offset_distance: float = 0.0,
    canopy_height: float = 0.0,
    refine_steps: int = 0,
    relax_iterations: int = 0,
    relax_strength: float = 0.35,
    damping: float = 0.95,
    load: float = 0.0,
    edge_length_factor: float = 1.0,
) -> dict:
    """Convert multiple closed polylines into a combined mesh.

    Assumptions:
      - Polylines may represent multiple disjoint outer polygons.
      - If one closed polyline is inside another, it becomes a hole.

    This is a best-effort approach without relying on Rhino/Grasshopper.
    """

    if not polylines:
        return {"vertices": [], "faces": []}

    # Prepare rings
    rings = [
        _close(np.asarray(p.points_xz, dtype=np.float64))
        for p in polylines
        if len(p.points_xz) >= 3
    ]
    # remove duplicated last point for containment tests
    rings = [r[:-1] if np.allclose(r[0], r[-1]) else r for r in rings]

    # simple point-in-polygon test using ray casting in 2D
    def pip(point: np.ndarray, ring: np.ndarray) -> bool:
        x, y0 = float(point[0]), float(point[1])
        inside = False
        n = len(ring)
        for i in range(n):
            x1, y1 = float(ring[i][0]), float(ring[i][1])
            x2, y2 = float(ring[(i + 1) % n][0]), float(ring[(i + 1) % n][1])
            if (y1 > y0) != (y2 > y0):
                xinters = (x2 - x1) * (y0 - y1) / (y2 - y1 + 1e-18) + x1
                if x < xinters:
                    inside = not inside
        return inside

    # Build containment graph
    parents = [-1] * len(rings)
    parent_area = [float("inf")] * len(rings)
    areas = [abs(_signed_area(r)) for r in rings]

    for i, ring in enumerate(rings):
        test_pt = ring[0]
        for j, other in enumerate(rings):
            if i == j:
                continue
            if areas[j] < areas[i]:
                continue
            if pip(test_pt, other):
                if areas[j] < parent_area[i]:
                    parent_area[i] = areas[j]
                    parents[i] = j

    # outer rings are those with no parent
    outer_ids = [i for i, p in enumerate(parents) if p == -1]

    all_vertices: list[list[float]] = []
    all_faces: list[list[int]] = []
    v_offset = 0

    for oid in outer_ids:
        hole_ids = [i for i, p in enumerate(parents) if p == oid]
        outer_pl = Polyline(points_xz=rings[oid])
        holes_pl = [Polyline(points_xz=rings[hid]) for hid in hole_ids]
        part = mesh_from_polygon_xz(
            outer_pl,
            holes=holes_pl,
            y=y,
            offset_distance=offset_distance,
            canopy_height=canopy_height,
            refine_steps=refine_steps,
            relax_iterations=relax_iterations,
            relax_strength=relax_strength,
            damping=damping,
            load=load,
            edge_length_factor=edge_length_factor,
        )

        verts = np.asarray(part["vertices"], dtype=np.float64)
        faces = np.asarray(part["faces"], dtype=np.int64) + v_offset

        all_vertices.extend(verts.tolist())
        all_faces.extend(faces.tolist())
        v_offset += len(verts)

    return {
        "vertices": all_vertices,
        "faces": all_faces,
    }
