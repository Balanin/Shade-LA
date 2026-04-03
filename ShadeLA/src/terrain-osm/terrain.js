import * as THREE from "three";
import { fromArrayBuffer } from "geotiff";

const MAX_MESH_DIMENSION = 256;
const MAX_VERTEX_COUNT = 180000;

function parseNoDataValue(image) {
  const rawNoData = image.getGDALNoData();
  if (rawNoData === null || rawNoData === undefined) {
    return null;
  }

  const parsed = Number(rawNoData);
  return Number.isFinite(parsed) ? parsed : null;
}

function chooseDownsampledSize(width, height) {
  const scaleByDimension = Math.min(1, MAX_MESH_DIMENSION / Math.max(width, height));
  const scaleByCount = Math.min(1, Math.sqrt(MAX_VERTEX_COUNT / (width * height)));
  const scale = Math.min(scaleByDimension, scaleByCount);

  return {
    width: Math.max(2, Math.floor(width * scale)),
    height: Math.max(2, Math.floor(height * scale)),
    scale,
  };
}

function resampleRaster(source, sourceWidth, sourceHeight, targetWidth, targetHeight, noDataValue) {
  const resampled = new Float32Array(targetWidth * targetHeight);
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;
  let validCount = 0;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY0 = Math.floor((y / targetHeight) * sourceHeight);
    const sourceY1 = Math.min(sourceHeight, Math.ceil(((y + 1) / targetHeight) * sourceHeight));

    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX0 = Math.floor((x / targetWidth) * sourceWidth);
      const sourceX1 = Math.min(sourceWidth, Math.ceil(((x + 1) / targetWidth) * sourceWidth));
      let sum = 0;
      let samples = 0;

      for (let sy = sourceY0; sy < sourceY1; sy += 1) {
        for (let sx = sourceX0; sx < sourceX1; sx += 1) {
          const value = source[sy * sourceWidth + sx];
          const isNoData = noDataValue !== null && Math.abs(value - noDataValue) < 1e-6;
          if (!Number.isFinite(value) || isNoData) {
            continue;
          }

          sum += value;
          samples += 1;
        }
      }

      const index = y * targetWidth + x;
      const averagedValue = samples > 0 ? sum / samples : Number.NaN;
      resampled[index] = averagedValue;

      if (Number.isFinite(averagedValue)) {
        minElevation = Math.min(minElevation, averagedValue);
        maxElevation = Math.max(maxElevation, averagedValue);
        validCount += 1;
      }
    }
  }

  if (!validCount) {
    throw new Error("The GeoTIFF did not contain any readable elevation values for the selected area.");
  }

  return { raster: resampled, minElevation, maxElevation };
}

function fillMissingValues(raster, width, height) {
  const filled = new Float32Array(raster);

  for (let index = 0; index < filled.length; index += 1) {
    if (Number.isFinite(filled[index])) {
      continue;
    }

    const x = index % width;
    const y = Math.floor(index / width);
    let sum = 0;
    let count = 0;

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (!offsetX && !offsetY) {
          continue;
        }

        const sampleX = x + offsetX;
        const sampleY = y + offsetY;
        if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
          continue;
        }

        const value = raster[sampleY * width + sampleX];
        if (Number.isFinite(value)) {
          sum += value;
          count += 1;
        }
      }
    }

    filled[index] = count > 0 ? sum / count : 0;
  }

  return filled;
}

function normalize(value, min, max) {
  if (!Number.isFinite(value) || max <= min) {
    return 0;
  }

  return (value - min) / (max - min);
}

function rampColor(value) {
  const stops = [
    { position: 0, color: new THREE.Color("#1f4b73") },
    { position: 0.2, color: new THREE.Color("#4e7f52") },
    { position: 0.45, color: new THREE.Color("#b5a067") },
    { position: 0.7, color: new THREE.Color("#7f5a3e") },
    { position: 1, color: new THREE.Color("#f3f1eb") },
  ];

  for (let index = 1; index < stops.length; index += 1) {
    const start = stops[index - 1];
    const end = stops[index];
    if (value <= end.position) {
      const t = (value - start.position) / (end.position - start.position);
      return start.color.clone().lerp(end.color, THREE.MathUtils.clamp(t, 0, 1));
    }
  }

  return stops.at(-1).color.clone();
}

function computeHillshade(raster, width, height, x, y, terrainWidth, terrainDepth, heightScale) {
  const left = raster[y * width + Math.max(0, x - 1)];
  const right = raster[y * width + Math.min(width - 1, x + 1)];
  const up = raster[Math.max(0, y - 1) * width + x];
  const down = raster[Math.min(height - 1, y + 1) * width + x];
  const dzdx = ((right - left) / 2) / (terrainWidth / Math.max(1, width - 1));
  const dzdy = ((down - up) / 2) / (terrainDepth / Math.max(1, height - 1));
  const normal = new THREE.Vector3(-dzdx, 1 / Math.max(heightScale, 0.0001), -dzdy).normalize();
  const lightDirection = new THREE.Vector3(0.5, 1, 0.35).normalize();
  return THREE.MathUtils.clamp(normal.dot(lightDirection) * 0.5 + 0.5, 0, 1);
}

function buildTexture(raster, width, height, minElevation, maxElevation, options) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const imageData = context.createImageData(width, height);
  const { colorMode, hillshadeEnabled, terrainWidth, terrainDepth, heightScale } = options;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const normalizedValue = normalize(raster[index], minElevation, maxElevation);
      const shade = hillshadeEnabled
        ? computeHillshade(raster, width, height, x, y, terrainWidth, terrainDepth, heightScale)
        : 1;

      const color =
        colorMode === "grayscale"
          ? new THREE.Color(normalizedValue, normalizedValue, normalizedValue)
          : rampColor(normalizedValue);

      color.multiplyScalar(0.55 + shade * 0.45);

      const pixelIndex = index * 4;
      imageData.data[pixelIndex] = Math.round(color.r * 255);
      imageData.data[pixelIndex + 1] = Math.round(color.g * 255);
      imageData.data[pixelIndex + 2] = Math.round(color.b * 255);
      imageData.data[pixelIndex + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export async function parseGeoTiff(arrayBuffer) {
  let image;

  try {
    const tiff = await fromArrayBuffer(arrayBuffer);
    image = await tiff.getImage();
  } catch (error) {
    throw new Error(`Unable to parse GeoTIFF. ${error instanceof Error ? error.message : String(error)}`);
  }

  const sourceWidth = image.getWidth();
  const sourceHeight = image.getHeight();
  const noDataValue = parseNoDataValue(image);
  const targetSize = chooseDownsampledSize(sourceWidth, sourceHeight);
  const rasterResult = await image.readRasters({
    interleave: true,
    width: targetSize.width,
    height: targetSize.height,
    resampleMethod: "bilinear",
  });

  const stats = resampleRaster(rasterResult, targetSize.width, targetSize.height, targetSize.width, targetSize.height, noDataValue);
  const filled = fillMissingValues(stats.raster, targetSize.width, targetSize.height);

  return {
    raster: filled,
    width: targetSize.width,
    height: targetSize.height,
    minElevation: stats.minElevation,
    maxElevation: stats.maxElevation,
    scale: targetSize.scale,
  };
}

export function createTerrainMesh(parsedTerrain, terrainWidth, terrainDepth) {
  const geometry = new THREE.PlaneGeometry(terrainWidth, terrainDepth, parsedTerrain.width - 1, parsedTerrain.height - 1);
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position;

  for (let index = 0; index < positions.count; index += 1) {
    const elevation = parsedTerrain.raster[index];
    positions.setY(index, Number.isFinite(elevation) ? elevation - parsedTerrain.minElevation : 0);
  }

  positions.needsUpdate = true;
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: "#cbd5e1",
    roughness: 0.95,
    metalness: 0,
    transparent: true,
    opacity: 1,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  return { mesh, geometry, material };
}

export function updateTerrainMaterial(terrainState, options) {
  if (!terrainState) {
    return;
  }

  const { material, parsedTerrain, terrainWidth, terrainDepth } = terrainState;

  const texture = buildTexture(parsedTerrain.raster, parsedTerrain.width, parsedTerrain.height, parsedTerrain.minElevation, parsedTerrain.maxElevation, {
    ...options,
    terrainWidth,
    terrainDepth,
    heightScale: options.exaggeration,
  });

  if (material.map) {
    material.map.dispose();
  }

  material.map = texture;
  material.wireframe = options.wireframe;
  material.needsUpdate = true;
}

export function applyVerticalExaggeration(terrainState, exaggeration) {
  if (!terrainState) {
    return;
  }

  terrainState.mesh.scale.y = exaggeration;
}

export function formatElevationRange(parsedTerrain) {
  return `${parsedTerrain.minElevation.toFixed(1)} to ${parsedTerrain.maxElevation.toFixed(1)} m`;
}

export function formatTerrainSize(width, depth) {
  const kmWidth = width / 1000;
  const kmDepth = depth / 1000;
  return `${kmWidth.toFixed(2)} km x ${kmDepth.toFixed(2)} km`;
}
