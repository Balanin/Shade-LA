from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np
import trimesh


@dataclass
class TerrainHeightfield:
    width: int
    height: int
    terrain_width: float
    terrain_depth: float
    min_elevation: float
    raster: np.ndarray

    @property
    def cell_size(self) -> float:
        return max(
            self.terrain_width / max(1, self.width - 1),
            self.terrain_depth / max(1, self.height - 1),
        )

    def sample_height(self, x: float, z: float) -> float:
        if not (-self.terrain_width / 2 <= x <= self.terrain_width / 2):
            return self.min_elevation
        if not (-self.terrain_depth / 2 <= z <= self.terrain_depth / 2):
            return self.min_elevation

        column = ((x + self.terrain_width / 2) / self.terrain_width) * (self.width - 1)
        row = ((z + self.terrain_depth / 2) / self.terrain_depth) * (self.height - 1)

        x0 = int(math.floor(column))
        x1 = min(self.width - 1, int(math.ceil(column)))
        y0 = int(math.floor(row))
        y1 = min(self.height - 1, int(math.ceil(row)))
        tx = column - x0
        ty = row - y0

        top = self.raster[y0, x0] * (1 - tx) + self.raster[y0, x1] * tx
        bottom = self.raster[y1, x0] * (1 - tx) + self.raster[y1, x1] * tx
        return float(top * (1 - ty) + bottom * ty)


def build_building_intersector(building_mesh: dict | None):
    if not building_mesh:
        return None

    vertices = np.asarray(building_mesh.get("vertices", []), dtype=np.float64)
    faces = np.asarray(building_mesh.get("faces", []), dtype=np.int64)
    if len(vertices) == 0 or len(faces) == 0:
        return None

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    return trimesh.ray.ray_triangle.RayMeshIntersector(mesh)


def is_occluded_by_buildings(origin: np.ndarray, direction: np.ndarray, intersector) -> bool:
    if intersector is None:
        return False

    hit = intersector.intersects_any(
        ray_origins=np.array([origin + direction * 0.2]),
        ray_directions=np.array([direction]),
    )
    return bool(hit[0])


def is_occluded_by_terrain(origin: np.ndarray, direction: np.ndarray, terrain: TerrainHeightfield) -> bool:
    if direction[1] <= 0:
        return True

    step_size = max(terrain.cell_size * 0.75, 1.0)
    max_distance = max(terrain.terrain_width, terrain.terrain_depth) * 2.5
    distance = step_size

    while distance <= max_distance:
        sample = origin + direction * distance
        if abs(sample[0]) > terrain.terrain_width / 2 or abs(sample[2]) > terrain.terrain_depth / 2:
            return False

        terrain_height = terrain.sample_height(sample[0], sample[2]) - terrain.min_elevation
        if terrain_height > sample[1] + 0.1:
            return True

        distance += step_size

    return False
