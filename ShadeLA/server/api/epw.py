from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Query

from server.cache.cache import DiskCache
from server.weather.epw_fetch import fetch_epw_for_station, load_station_catalog, select_best_station


router = APIRouter(prefix="/weather", tags=["weather"])
cache = DiskCache(Path(__file__).resolve().parent.parent / "cache" / ".runtime")


@router.get("/epw")
def get_epw_station(
    lat: float = Query(...),
    lon: float = Query(...),
    elevation: float | None = Query(default=None),
):
    stations = load_station_catalog(cache)
    station = select_best_station(stations, lat, lon, elevation)

    if not station:
        return {
            "available": False,
            "station": None,
            "message": (
                "No EPW station catalog is available. Set EPW_STATION_CATALOG_URL or add "
                "server/cache/epw_stations.json. Geometric mode is still available."
            ),
        }

    try:
        epw_result = fetch_epw_for_station(cache, station)
    except Exception as error:  # pragma: no cover
        return {
            "available": False,
            "station": station,
            "message": f"Station selected but EPW download failed: {error}",
        }

    return epw_result
