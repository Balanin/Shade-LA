from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import httpx

from server.cache.cache import DiskCache


CATALOG_ENV_VAR = "EPW_STATION_CATALOG_URL"


def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    earth_radius_km = 6371.0
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return earth_radius_km * c


def _normalize_station(raw_station: dict[str, Any]) -> dict[str, Any] | None:
    latitude = raw_station.get("latitude") or raw_station.get("lat")
    longitude = raw_station.get("longitude") or raw_station.get("lon") or raw_station.get("lng")
    station_id = raw_station.get("station_id") or raw_station.get("id")
    epw_url = raw_station.get("epw_url") or raw_station.get("url")

    if latitude is None or longitude is None or station_id is None:
        return None

    return {
        "station_id": str(station_id),
        "name": raw_station.get("name", str(station_id)),
        "latitude": float(latitude),
        "longitude": float(longitude),
        "elevation_m": float(raw_station.get("elevation_m") or raw_station.get("elevation") or 0.0),
        "epw_url": epw_url,
        "source": raw_station.get("source", "catalog"),
    }


def load_station_catalog(cache: DiskCache) -> list[dict[str, Any]]:
    cached = cache.get_json("weather", "station_catalog")
    if cached:
        return cached

    local_catalog = Path(__file__).resolve().parent.parent / "cache" / "epw_stations.json"
    if local_catalog.exists():
        stations = json.loads(local_catalog.read_text(encoding="utf-8"))
        cache.set_json("weather", "station_catalog", stations)
        return stations

    catalog_url = os.getenv(CATALOG_ENV_VAR)
    if not catalog_url:
        return []

    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        response = client.get(catalog_url)
        response.raise_for_status()
        raw_data = response.json()

    raw_stations = raw_data.get("stations", raw_data) if isinstance(raw_data, dict) else raw_data
    stations = [station for raw_station in raw_stations if (station := _normalize_station(raw_station))]
    cache.set_json("weather", "station_catalog", stations)
    return stations


def select_best_station(
    stations: list[dict[str, Any]],
    latitude: float,
    longitude: float,
    elevation_m: float | None = None,
) -> dict[str, Any] | None:
    ranked_candidates: list[tuple[float, dict[str, Any]]] = []

    for station in stations:
        distance_km = haversine_distance_km(latitude, longitude, station["latitude"], station["longitude"])
        elevation_penalty = 0.0
        if elevation_m is not None:
            elevation_penalty = abs(station.get("elevation_m", 0.0) - elevation_m) / 1000.0

        score = distance_km + elevation_penalty
        ranked_candidates.append((score, station | {"distance_km": distance_km}))

    if not ranked_candidates:
        return None

    ranked_candidates.sort(key=lambda item: item[0])
    return ranked_candidates[0][1]


def fetch_epw_for_station(cache: DiskCache, station: dict[str, Any]) -> dict[str, Any]:
    station_id = station["station_id"]
    cached_path = Path(cache.root) / "epw" / f"{station_id}.epw"

    if cached_path.exists():
        return {
            "available": True,
            "station": station,
            "cached_path": str(cached_path),
            "cached": True,
        }

    epw_url = station.get("epw_url")
    if not epw_url:
        return {
            "available": False,
            "station": station,
            "cached_path": None,
            "cached": False,
            "message": "Station catalog does not provide an EPW download URL.",
        }

    with httpx.Client(timeout=60.0, follow_redirects=True) as client:
        response = client.get(epw_url)
        response.raise_for_status()
        cache.set_bytes("epw", station_id, response.content, extension=".epw")

    return {
        "available": True,
        "station": station,
        "cached_path": str(cached_path),
        "cached": False,
    }
