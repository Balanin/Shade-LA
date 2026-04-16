from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from server.analysis.direct_sun_hours import run_direct_sun_hours
from server.cache.cache import DiskCache
from server.weather.epw_fetch import fetch_epw_for_station, load_station_catalog, select_best_station


router = APIRouter(prefix="/analysis", tags=["analysis"])
cache = DiskCache(Path(__file__).resolve().parent.parent / "cache" / ".runtime")


@router.post("/direct-sun-hours")
def direct_sun_hours(payload: dict):
    station_id = payload.get("epw_station_id")
    epw_path = None

    if payload.get("mode") == "climate":
        stations = load_station_catalog(cache)
        station = None
        if station_id:
            station = next((item for item in stations if item["station_id"] == station_id), None)
        else:
            bounds = payload["bounds"]
            station = select_best_station(
                stations,
                (bounds["minLat"] + bounds["maxLat"]) / 2,
                (bounds["minLon"] + bounds["maxLon"]) / 2,
            )

        if station:
            try:
                epw_result = fetch_epw_for_station(cache, station)
                if epw_result.get("available"):
                    epw_path = epw_result.get("cached_path")
            except Exception:
                epw_path = None

    analysis_key = cache.make_key(
        {
            "bounds": payload["bounds"],
            "terrain": {
                "width": payload["terrain"]["width"],
                "height": payload["terrain"]["height"],
                "terrain_width": payload["terrain"]["terrain_width"],
                "terrain_depth": payload["terrain"]["terrain_depth"],
                "min_elevation": payload["terrain"]["min_elevation"],
                "raster_hash": cache.make_key(payload["terrain"]["raster"]),
            },
            "building_mesh_hash": cache.make_key(payload.get("building_mesh", {})),
            "shade_meshes_hash": cache.make_key(payload.get("shade_meshes", [])),
            "analysis_period": payload["analysis_period"],
            "timestep": payload.get("timestep"),
            "north": payload.get("north"),
            "grid_spacing": payload.get("grid_spacing"),
            "mode": payload.get("mode"),
            "epw_station_id": station_id,
            "epw_path": epw_path,
        }
    )

    cached = cache.get_json("analysis", analysis_key)
    if cached:
        cached.setdefault("metadata", {})
        cached["metadata"]["cached"] = True
        return cached

    result = run_direct_sun_hours(payload | {"epw_path": epw_path})
    result["metadata"]["cached"] = False
    result["metadata"]["epw_path"] = epw_path
    cache.set_json("analysis", analysis_key, result)
    return result
