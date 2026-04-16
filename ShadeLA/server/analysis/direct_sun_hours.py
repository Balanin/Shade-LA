from __future__ import annotations

from datetime import date
from typing import Any

import numpy as np

from ladybug.epw import EPW

from server.analysis.raycast import (
    TerrainHeightfield,
    build_building_intersector,
    build_shade_intersectors,
    is_occluded_by_buildings,
    is_occluded_by_terrain,
    shade_cooling_factor,
)
from server.analysis.sun import generate_sun_vectors


def _parse_date(value: str) -> date:
    return date.fromisoformat(value)


def _build_dni_lookup(epw_path: str | None) -> dict[tuple[int, int, int], float]:
    if not epw_path:
        return {}

    epw = EPW(epw_path)
    dni_values = epw.direct_normal_radiation.values
    datetimes = epw.datetimes
    return {
        (moment.month, moment.day, moment.hour): float(dni)
        for moment, dni in zip(datetimes, dni_values, strict=False)
    }


def _generate_analysis_points(terrain: TerrainHeightfield, grid_spacing: float) -> np.ndarray:
    x_values = np.arange(-terrain.terrain_width / 2, terrain.terrain_width / 2 + grid_spacing, grid_spacing)
    z_values = np.arange(-terrain.terrain_depth / 2, terrain.terrain_depth / 2 + grid_spacing, grid_spacing)

    points = []
    for z in z_values:
        for x in x_values:
            y = terrain.sample_height(x, z) - terrain.min_elevation
            points.append((float(x), float(y), float(z)))

    return np.asarray(points, dtype=np.float64)


def run_direct_sun_hours(payload: dict[str, Any]) -> dict[str, Any]:
    terrain_payload = payload["terrain"]
    bounds = payload["bounds"]
    latitude = (bounds["minLat"] + bounds["maxLat"]) / 2
    longitude = (bounds["minLon"] + bounds["maxLon"]) / 2
    timestep_hours = float(payload.get("timestep", 1.0))
    requested_mode = payload.get("mode", "geometric")
    epw_path = payload.get("epw_path")

    terrain = TerrainHeightfield(
        width=int(terrain_payload["width"]),
        height=int(terrain_payload["height"]),
        terrain_width=float(terrain_payload["terrain_width"]),
        terrain_depth=float(terrain_payload["terrain_depth"]),
        min_elevation=float(terrain_payload["min_elevation"]),
        raster=np.asarray(terrain_payload["raster"], dtype=np.float64).reshape(
            int(terrain_payload["height"]),
            int(terrain_payload["width"]),
        ),
    )

    building_intersector = build_building_intersector(payload.get("building_mesh"))
    shade_intersectors = build_shade_intersectors(payload.get("shade_meshes"))
    sun_vectors = generate_sun_vectors(
        latitude=latitude,
        longitude=longitude,
        start_date=_parse_date(payload["analysis_period"]["start_date"]),
        end_date=_parse_date(payload["analysis_period"]["end_date"]),
        start_hour=float(payload["analysis_period"]["start_hour"]),
        end_hour=float(payload["analysis_period"]["end_hour"]),
        timestep_hours=timestep_hours,
        north_angle_degrees=float(payload.get("north", 0.0)),
    )

    dni_lookup = _build_dni_lookup(epw_path) if requested_mode == "climate" and epw_path else {}
    mode = requested_mode if requested_mode == "geometric" or dni_lookup else "geometric"

    analysis_points = _generate_analysis_points(terrain, float(payload.get("grid_spacing", 10.0)))
    sun_hours = np.zeros(len(analysis_points), dtype=np.float64)

    for vector in sun_vectors:
        if mode == "climate":
            dni = dni_lookup.get((vector.timestamp.month, vector.timestamp.day, vector.timestamp.hour))
            if dni is None or dni <= 0:
                continue

        direction = np.asarray(vector.direction, dtype=np.float64)
        for index, point in enumerate(analysis_points):
            origin = np.array([point[0], point[1] + 0.05, point[2]], dtype=np.float64)
            if is_occluded_by_terrain(origin, direction, terrain):
                continue
            if is_occluded_by_buildings(origin, direction, building_intersector):
                continue
            factor = shade_cooling_factor(origin, direction, shade_intersectors)
            sun_hours[index] += timestep_hours * (1.0 - float(factor))

    points = analysis_points.tolist()
    sun_hours_list = sun_hours.tolist()

    return {
        "points": points,
        "sun_hours": sun_hours_list,
        "min": float(np.min(sun_hours)) if len(sun_hours) else 0.0,
        "max": float(np.max(sun_hours)) if len(sun_hours) else 0.0,
        "metadata": {
            "mode": mode,
            "requested_mode": requested_mode,
            "vector_count": len(sun_vectors),
            "timestep_hours": timestep_hours,
            "grid_spacing": float(payload.get("grid_spacing", 10.0)),
            "epw_used": bool(dni_lookup),
        },
    }
