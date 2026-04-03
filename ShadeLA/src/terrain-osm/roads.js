import osmtogeojson from "osmtogeojson";
import * as THREE from "three";
import { boundsToKey, lonLatToLocalMeters, sampleRasterElevation } from "./geo.js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const roadCache = new Map();
const ROAD_SURFACE_OFFSET = 0.18;
const ROAD_THICKNESS = 0.28;

const HIGHWAY_STYLES = {
  motorway: { color: "#f97316", width: 12 },
  trunk: { color: "#fb923c", width: 10 },
  primary: { color: "#f59e0b", width: 8 },
  secondary: { color: "#facc15", width: 7 },
  tertiary: { color: "#84cc16", width: 6 },
  residential: { color: "#e2e8f0", width: 5 },
  unclassified: { color: "#cbd5e1", width: 4.5 },
  service: { color: "#cbd5e1", width: 4 },
  living_street: { color: "#dbeafe", width: 4.5 },
  track: { color: "#c08457", width: 3 },
  path: { color: "#94a3b8", width: 2 },
  footway: { color: "#94a3b8", width: 1.8 },
  cycleway: { color: "#60a5fa", width: 2.2 },
};

function parseNumericMeters(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  const numberMatch = normalized.match(/-?\d+(\.\d+)?/);
  if (!numberMatch) {
    return null;
  }

  const numericValue = Number(numberMatch[0]);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  if (normalized.includes("ft") || normalized.includes("feet")) {
    return numericValue * 0.3048;
  }

  return numericValue;
}

function buildRoadQuery(bounds) {
  return `
[out:json][timeout:30];
(
  way["highway"](${bounds.minLat},${bounds.minLon},${bounds.maxLat},${bounds.maxLon});
);
out body;
>;
out skel qt;
  `.trim();
}

function filterRoadFeatures(geoJson) {
  return geoJson.features.filter((feature) => {
    const highway = feature.properties?.highway;
    const geometryType = feature.geometry?.type;
    const isLine = geometryType === "LineString" || geometryType === "MultiLineString";
    const isBridge = feature.properties?.bridge && feature.properties.bridge !== "no";
    const isTunnel = feature.properties?.tunnel && feature.properties.tunnel !== "no";
    return Boolean(highway) && isLine && !isTunnel && !isBridge;
  });
}

function interpolatePoint(start, end, t) {
  return {
    lon: start.lon + (end.lon - start.lon) * t,
    lat: start.lat + (end.lat - start.lat) * t,
  };
}

function clipSegmentToBounds(start, end, bounds) {
  const dx = end.lon - start.lon;
  const dy = end.lat - start.lat;
  let t0 = 0;
  let t1 = 1;

  const tests = [
    [-dx, start.lon - bounds.minLon],
    [dx, bounds.maxLon - start.lon],
    [-dy, start.lat - bounds.minLat],
    [dy, bounds.maxLat - start.lat],
  ];

  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) {
        return null;
      }
      continue;
    }

    const ratio = q / p;
    if (p < 0) {
      if (ratio > t1) {
        return null;
      }
      if (ratio > t0) {
        t0 = ratio;
      }
    } else {
      if (ratio < t0) {
        return null;
      }
      if (ratio < t1) {
        t1 = ratio;
      }
    }
  }

  return [interpolatePoint(start, end, t0), interpolatePoint(start, end, t1)];
}

function arePointsEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a.lon - b.lon) < epsilon && Math.abs(a.lat - b.lat) < epsilon;
}

function clipLineStringToBounds(coordinates, bounds) {
  const clippedLines = [];
  let currentLine = [];

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = { lon: coordinates[index][0], lat: coordinates[index][1] };
    const end = { lon: coordinates[index + 1][0], lat: coordinates[index + 1][1] };
    const clippedSegment = clipSegmentToBounds(start, end, bounds);

    if (!clippedSegment) {
      if (currentLine.length > 1) {
        clippedLines.push(currentLine);
      }
      currentLine = [];
      continue;
    }

    const [clippedStart, clippedTo] = clippedSegment;

    if (currentLine.length === 0) {
      currentLine = [clippedStart, clippedTo];
      continue;
    }

    const lastPoint = currentLine[currentLine.length - 1];
    if (arePointsEqual(lastPoint, clippedStart)) {
      currentLine.push(clippedTo);
    } else {
      if (currentLine.length > 1) {
        clippedLines.push(currentLine);
      }
      currentLine = [clippedStart, clippedTo];
    }
  }

  if (currentLine.length > 1) {
    clippedLines.push(currentLine);
  }

  return clippedLines;
}

function lineSetsFromFeature(feature) {
  if (feature.geometry.type === "LineString") {
    return [feature.geometry.coordinates];
  }

  if (feature.geometry.type === "MultiLineString") {
    return feature.geometry.coordinates;
  }

  return [];
}

function getRoadStyle(feature) {
  const highway = feature.properties?.highway ?? "residential";
  const baseStyle = HIGHWAY_STYLES[highway] ?? { color: "#dbeafe", width: 4 };
  const explicitWidth = parseNumericMeters(feature.properties?.width);
  const lanes = parseNumericMeters(feature.properties?.lanes);

  let widthMeters = explicitWidth;
  if (widthMeters === null && lanes !== null) {
    widthMeters = lanes * 3.2;
  }
  if (widthMeters === null) {
    widthMeters = baseStyle.width;
  }

  return {
    color: baseStyle.color,
    width: Math.max(1, Math.min(24, widthMeters)),
  };
}

function buildRoadPositions(clippedLine, parsedTerrain, geoReference) {
  return clippedLine.map((point) => {
    const local = lonLatToLocalMeters(point.lon, point.lat, geoReference);
    const terrainElevation = sampleRasterElevation(parsedTerrain, geoReference, point.lon, point.lat);
    return new THREE.Vector3(local.x, terrainElevation - parsedTerrain.minElevation + ROAD_SURFACE_OFFSET, local.z);
  });
}

function createRoadSegmentGeometry(startPoint, endPoint, widthMeters) {
  const heading = new THREE.Vector3(endPoint.x - startPoint.x, 0, endPoint.z - startPoint.z);
  if (heading.lengthSq() < 1e-6) {
    return null;
  }

  heading.normalize();
  const left = new THREE.Vector3(-heading.z, 0, heading.x).multiplyScalar(widthMeters / 2);
  const thicknessVector = new THREE.Vector3(0, ROAD_THICKNESS, 0);

  const startLeft = startPoint.clone().add(left);
  const startRight = startPoint.clone().sub(left);
  const endLeft = endPoint.clone().add(left);
  const endRight = endPoint.clone().sub(left);

  const vertices = new Float32Array([
    startLeft.x,
    startLeft.y,
    startLeft.z,
    startRight.x,
    startRight.y,
    startRight.z,
    endRight.x,
    endRight.y,
    endRight.z,
    endLeft.x,
    endLeft.y,
    endLeft.z,
    startLeft.x,
    startLeft.y + thicknessVector.y,
    startLeft.z,
    startRight.x,
    startRight.y + thicknessVector.y,
    startRight.z,
    endRight.x,
    endRight.y + thicknessVector.y,
    endRight.z,
    endLeft.x,
    endLeft.y + thicknessVector.y,
    endLeft.z,
  ]);

  const indices = [
    0,
    1,
    2,
    0,
    2,
    3,
    4,
    6,
    5,
    4,
    7,
    6,
    0,
    4,
    5,
    0,
    5,
    1,
    1,
    5,
    6,
    1,
    6,
    2,
    2,
    6,
    7,
    2,
    7,
    3,
    3,
    7,
    4,
    3,
    4,
    0,
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function appendRoadMeshesFromLine(parent, clippedLine, parsedTerrain, geoReference, widthScale, style, material) {
  const positions = buildRoadPositions(clippedLine, parsedTerrain, geoReference);
  const widthMeters = style.width * widthScale;

  for (let index = 0; index < positions.length - 1; index += 1) {
    const startPoint = positions[index];
    const endPoint = positions[index + 1];
    const geometry = createRoadSegmentGeometry(startPoint, endPoint, widthMeters);
    if (!geometry) {
      continue;
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
}

export async function fetchRoadGeoJson(bounds, logger = console.log) {
  const cacheKey = boundsToKey(bounds);
  if (roadCache.has(cacheKey)) {
    logger("Using cached road features for current bbox.");
    return roadCache.get(cacheKey);
  }

  const query = buildRoadQuery(bounds);
  logger("Fetching OSM roads from Overpass...");

  let response;

  try {
    response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: query,
    });
  } catch (error) {
    throw new Error(`Road request failed due to network or CORS issues. ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Overpass request failed with ${response.status}. ${details}`.trim());
  }

  const osmJson = await response.json();
  const geoJson = osmtogeojson(osmJson);
  const features = filterRoadFeatures(geoJson);

  roadCache.set(cacheKey, features);
  logger(`Received ${features.length} road features from Overpass.`);

  return features;
}

export function createRoadGroup(features, parsedTerrain, geoReference, options) {
  const group = new THREE.Group();
  group.name = "roads";

  const material = new THREE.MeshStandardMaterial({
    color: "#9ca3af",
    roughness: 0.95,
    metalness: 0.0,
    transparent: true,
    opacity: options.opacity,
    depthWrite: true,
  });

  let roadCount = 0;

  for (const feature of features) {
    const style = getRoadStyle(feature);
    const lineSets = lineSetsFromFeature(feature);

    material.color = new THREE.Color(style.color);
    material.needsUpdate = true;

    for (const line of lineSets) {
      const clippedLines = clipLineStringToBounds(line, geoReference.bounds);
      for (const clippedLine of clippedLines) {
        if (clippedLine.length < 2) {
          continue;
        }

        appendRoadMeshesFromLine(group, clippedLine, parsedTerrain, geoReference, options.widthScale, style, material);
        roadCount += 1;
      }
    }
  }

  group.visible = options.showRoads;
  group.scale.y = options.exaggeration;
  group.userData = {
    material,
    roadCount,
    features,
  };

  return group;
}

export function updateRoadDisplay(group, options) {
  if (!group) {
    return;
  }

  group.visible = options.showRoads;
  group.scale.y = options.exaggeration;

  if (group.userData.material) {
    group.userData.material.opacity = options.opacity;
    group.userData.material.needsUpdate = true;
  }
}

export function disposeRoadGroup(group) {
  if (!group) {
    return;
  }

  group.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose?.();
    }
  });

  group.userData.material?.dispose();
}
