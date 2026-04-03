import * as THREE from "three";
import osmtogeojson from "osmtogeojson";
import { boundsToKey, lonLatToLocalMeters, sampleRasterElevation } from "./geo.js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const buildingCache = new Map();

function parseNumericMeters(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  const match = normalized.match(/-?\d+(\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNonNegative(value) {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

function getBuildingHeightProperties(tags, options) {
  const explicitHeight = parseNumericMeters(tags.height);
  const explicitMinHeight = parseNumericMeters(tags.min_height);
  const levels = parseNumericMeters(tags["building:levels"]);

  const height =
    explicitHeight !== null
      ? explicitHeight
      : levels !== null
        ? levels * options.defaultFloorHeight
        : options.defaultBuildingHeight;

  return {
    height: clampNonNegative(height),
    minHeight: clampNonNegative(explicitMinHeight),
  };
}

function buildOverpassQuery(bounds) {
  return `
[out:json][timeout:30];
(
  way["building"](${bounds.minLat},${bounds.minLon},${bounds.maxLat},${bounds.maxLon});
  relation["building"](${bounds.minLat},${bounds.minLon},${bounds.maxLat},${bounds.maxLon});
);
out body;
>;
out skel qt;
  `.trim();
}

function filterBuildingFeatures(geoJson) {
  return geoJson.features.filter((feature) => {
    const hasBuildingTag = Boolean(feature.properties?.building);
    const isPolygon = feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon";
    return hasBuildingTag && isPolygon;
  });
}

function ensureClosedRing(ring) {
  if (ring.length < 4) {
    return ring;
  }

  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];

  if (firstLon === lastLon && firstLat === lastLat) {
    return ring;
  }

  return [...ring, ring[0]];
}

function ringWithoutDuplicateClosure(ring) {
  if (ring.length < 2) {
    return ring;
  }

  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];
  return firstLon === lastLon && firstLat === lastLat ? ring.slice(0, -1) : ring;
}

function ringToLocalPoints(ring, geoReference) {
  return ringWithoutDuplicateClosure(ring).map(([lon, lat]) => {
    const local = lonLatToLocalMeters(lon, lat, geoReference);
    return new THREE.Vector2(local.x, -local.z);
  });
}

function createShapeFromRingSet(rings, geoReference) {
  const [outerRing, ...holes] = rings;
  const closedOuter = ensureClosedRing(outerRing);
  if (closedOuter.length < 4) {
    return null;
  }

  const outerPoints = ringToLocalPoints(closedOuter, geoReference);

  const shape = new THREE.Shape(outerPoints);

  for (const holeRing of holes) {
    const closedHole = ensureClosedRing(holeRing);
    if (closedHole.length < 4) {
      continue;
    }

    const holePoints = ringToLocalPoints(closedHole, geoReference);

    shape.holes.push(new THREE.Path(holePoints));
  }

  return shape;
}

function sampleBuildingBaseElevation(rings, parsedTerrain, geoReference) {
  const samples = [];

  for (const [lon, lat] of rings[0]) {
    samples.push(sampleRasterElevation(parsedTerrain, geoReference, lon, lat));
  }

  const centroid = rings[0].reduce(
    (accumulator, [lon, lat]) => {
      accumulator.lon += lon;
      accumulator.lat += lat;
      return accumulator;
    },
    { lon: 0, lat: 0 }
  );

  const divisor = Math.max(1, rings[0].length);
  samples.push(
    sampleRasterElevation(
      parsedTerrain,
      geoReference,
      centroid.lon / divisor,
      centroid.lat / divisor
    )
  );

  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

function polygonSetsFromFeature(feature) {
  if (feature.geometry.type === "Polygon") {
    return [feature.geometry.coordinates];
  }

  if (feature.geometry.type === "MultiPolygon") {
    return feature.geometry.coordinates;
  }

  return [];
}

export async function fetchBuildingsGeoJson(bounds, logger = console.log) {
  const cacheKey = boundsToKey(bounds);
  if (buildingCache.has(cacheKey)) {
    logger("Using cached building footprints for current bbox.");
    return buildingCache.get(cacheKey);
  }

  const query = buildOverpassQuery(bounds);
  logger("Fetching OSM buildings from Overpass...");

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
    throw new Error(
      `Building request failed due to network or CORS issues. ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Overpass request failed with ${response.status}. ${details}`.trim());
  }

  const osmJson = await response.json();
  const geoJson = osmtogeojson(osmJson);
  const features = filterBuildingFeatures(geoJson);

  buildingCache.set(cacheKey, features);
  logger(`Received ${features.length} building features from Overpass.`);

  return features;
}

export function createBuildingGroup(features, parsedTerrain, geoReference, options) {
  const group = new THREE.Group();
  group.name = "buildings";

  const material = new THREE.MeshStandardMaterial({
    color: "#d0b084",
    roughness: 0.85,
    metalness: 0.05,
    transparent: true,
    opacity: options.opacity,
  });

  let buildingCount = 0;

  for (const feature of features) {
    const polygonSets = polygonSetsFromFeature(feature);
    const properties = getBuildingHeightProperties(feature.properties ?? {}, options);
    const extrusionHeight = Math.max(0.5, properties.height);

    for (const rings of polygonSets) {
      const shape = createShapeFromRingSet(rings, geoReference);
      if (!shape) {
        continue;
      }

      const baseElevation = sampleBuildingBaseElevation(rings, parsedTerrain, geoReference) - parsedTerrain.minElevation;
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: extrusionHeight,
        bevelEnabled: false,
        curveSegments: 1,
        steps: 1,
      });

      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, baseElevation + properties.minHeight, 0);
      geometry.computeVertexNormals();

      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData = {
        ...(mesh.userData || {}),
        building: {
          feature,
          key:
            feature?.id ??
            feature?.properties?.["@id"] ??
            feature?.properties?.id ??
            feature?.properties?.osm_id ??
            null,
          shape,
          baseElevation,
          minHeight: properties.minHeight,
          height: extrusionHeight,
          originalHeight: extrusionHeight,
        },
      };
      group.add(mesh);
      buildingCount += 1;
    }
  }

  group.visible = options.showBuildings;
  group.scale.y = options.exaggeration;
  group.userData = {
    material,
    buildingCount,
    features,
  };

  return group;
}

function roundAnalysisValue(value) {
  return Number(value.toFixed(3));
}

function appendPrismMeshFromRingSet(vertices, faces, rings, baseElevation, extrusionHeight, geoReference) {
  const contour = ringToLocalPoints(rings[0], geoReference);
  if (contour.length < 3) {
    return;
  }

  const holes = rings
    .slice(1)
    .map((ring) => ringToLocalPoints(ring, geoReference))
    .filter((ring) => ring.length >= 3);
  const triangulatedFaces = THREE.ShapeUtils.triangulateShape(contour, holes);
  const flattened = [...contour, ...holes.flat()];
  const vertexOffset = vertices.length;

  flattened.forEach((point) => {
    vertices.push([roundAnalysisValue(point.x), roundAnalysisValue(baseElevation), roundAnalysisValue(-point.y)]);
  });

  flattened.forEach((point) => {
    vertices.push([
      roundAnalysisValue(point.x),
      roundAnalysisValue(baseElevation + extrusionHeight),
      roundAnalysisValue(-point.y),
    ]);
  });

  const topOffset = vertexOffset + flattened.length;

  triangulatedFaces.forEach(([a, b, c]) => {
    faces.push([topOffset + a, topOffset + b, topOffset + c]);
    faces.push([vertexOffset + c, vertexOffset + b, vertexOffset + a]);
  });

  const wallRings = [contour, ...holes];
  let ringStart = 0;

  wallRings.forEach((ring) => {
    for (let index = 0; index < ring.length; index += 1) {
      const nextIndex = (index + 1) % ring.length;
      const bottomA = vertexOffset + ringStart + index;
      const bottomB = vertexOffset + ringStart + nextIndex;
      const topA = topOffset + ringStart + index;
      const topB = topOffset + ringStart + nextIndex;

      faces.push([bottomA, bottomB, topB]);
      faces.push([bottomA, topB, topA]);
    }

    ringStart += ring.length;
  });
}

export function createBuildingMeshPayload(features, parsedTerrain, geoReference, options) {
  const vertices = [];
  const faces = [];

  for (const feature of features ?? []) {
    const polygonSets = polygonSetsFromFeature(feature);
    const properties = getBuildingHeightProperties(feature.properties ?? {}, options);
    const extrusionHeight = Math.max(0.5, properties.height);

    for (const rings of polygonSets) {
      if (!rings?.length) {
        continue;
      }

      const baseElevation =
        sampleBuildingBaseElevation(rings, parsedTerrain, geoReference) - parsedTerrain.minElevation + properties.minHeight;
      appendPrismMeshFromRingSet(vertices, faces, rings, baseElevation, extrusionHeight, geoReference);
    }
  }

  return { vertices, faces };
}

export function updateBuildingDisplay(group, options) {
  if (!group) {
    return;
  }

  group.visible = options.showBuildings;
  group.scale.y = options.exaggeration;

  if (group.userData.material) {
    group.userData.material.opacity = options.opacity;
    group.userData.material.needsUpdate = true;
  }
}

export function disposeBuildingGroup(group) {
  if (!group) {
    return;
  }

  group.traverse((child) => {
    if (child.isMesh) {
      child.geometry.dispose();
    }
  });

  group.userData.material?.dispose();
}
