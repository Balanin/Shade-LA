import { createBuildingMeshPayload } from "./buildings.js";

const ANALYSIS_API_BASE_URL = import.meta.env.VITE_ANALYSIS_API_BASE_URL || "http://127.0.0.1:8000";

function buildApiUrl(path) {
  if (/^https?:\/\//.test(ANALYSIS_API_BASE_URL)) {
    return `${ANALYSIS_API_BASE_URL}${path}`;
  }

  return `${window.location.origin}${ANALYSIS_API_BASE_URL}${path}`;
}

export async function fetchEpwStatus(bounds) {
  const latitude = (bounds.minLat + bounds.maxLat) / 2;
  const longitude = (bounds.minLon + bounds.maxLon) / 2;
  const url = new URL(buildApiUrl("/weather/epw"));
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        available: false,
        station: null,
        cached: false,
        service_unavailable: true,
        message: `EPW lookup unavailable (${response.status}). Geometric mode is still available.`,
      };
    }

    return response.json();
  } catch (error) {
    return {
      available: false,
      station: null,
      cached: false,
      service_unavailable: true,
      message: "EPW service unavailable. Geometric mode is still available.",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDirectSunHoursAnalysis({
  bounds,
  terrainState,
  buildingFeatures,
  geoReference,
  buildingOptions,
  settings,
  epwStationId,
}) {
  const terrainPayload = {
    width: terrainState.width,
    height: terrainState.height,
    terrain_width: terrainState.terrainWidth,
    terrain_depth: terrainState.terrainDepth,
    min_elevation: terrainState.minElevation,
    raster: Array.from(terrainState.raster),
  };

  const payload = {
    bounds,
    terrain: terrainPayload,
    building_mesh: createBuildingMeshPayload(buildingFeatures, terrainState.parsedTerrain, geoReference, buildingOptions),
    analysis_period: settings.analysisPeriod,
    timestep: settings.timestep,
    north: settings.north,
    grid_spacing: settings.gridSpacing,
    mode: settings.mode,
    epw_station_id: epwStationId ?? null,
  };

  let response;

  try {
    response = await fetch(buildApiUrl("/analysis/direct-sun-hours"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the solar analysis backend. Check that http://127.0.0.1:8000 is running and retry with a smaller area if needed. ${
        error instanceof Error ? error.message : String(error)
      }`.trim()
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Direct sun hours analysis failed with ${response.status}. ${details}`.trim());
  }

  return response.json();
}

export async function runMeshFromPolylines({ polylines, options }) {
  const payload = {
    polylines: Array.isArray(polylines) ? polylines : [],
    options: options && typeof options === "object" ? options : {},
  };

  let response;
  try {
    response = await fetch(buildApiUrl("/analysis/mesh/from-polylines"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the mesh backend. Check that http://127.0.0.1:8000 is running. ${
        error instanceof Error ? error.message : String(error)
      }`.trim()
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Mesh generation failed with ${response.status}. ${details}`.trim());
  }

  return response.json();
}
