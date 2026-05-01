import * as THREE from "three";
import { sampleAnalysisColor } from "./analysis-colors.js";

const HEATMAP_BASE_OFFSET = 0.32;
const HEATMAP_RELIEF = 0.25;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function colorForNormalizedValue(value) {
  const sampled = sampleAnalysisColor(clamp01(value));
  return new THREE.Color(sampled.r / 255, sampled.g / 255, sampled.b / 255);
}

function uniqueSorted(values) {
  return Array.from(new Set(values.map((value) => Number(value.toFixed(6))))).sort((a, b) => a - b);
}

function createHeatmapGeometry(analysisResult) {
  const minValue = analysisResult.min ?? 0;
  const maxValue = analysisResult.max ?? 1;
  const range = Math.max(1e-6, maxValue - minValue);
  const useConstantColor = range < 1e-5;
  const xs = uniqueSorted(analysisResult.points.map((point) => point[0]));
  const zs = uniqueSorted(analysisResult.points.map((point) => point[2]));
  const width = xs.length;
  const depth = zs.length;

  const positions = new Float32Array(analysisResult.points.length * 3);
  const colors = new Float32Array(analysisResult.points.length * 3);
  const indices = [];

  analysisResult.points.forEach((point, index) => {
    const value = analysisResult.sun_hours[index] ?? minValue;
    const normalized = useConstantColor ? 0.78 : (value - minValue) / range;
    const color = colorForNormalizedValue(normalized);
    const relief = useConstantColor ? HEATMAP_RELIEF * 0.45 : normalized * HEATMAP_RELIEF;

    positions[index * 3] = point[0];
    positions[index * 3 + 1] = point[1] + HEATMAP_BASE_OFFSET + relief;
    positions[index * 3 + 2] = point[2];
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  });

  for (let row = 0; row < depth - 1; row += 1) {
    for (let column = 0; column < width - 1; column += 1) {
      const topLeft = row * width + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + width;
      const bottomRight = bottomLeft + 1;

      indices.push(topLeft, bottomLeft, topRight);
      indices.push(topRight, bottomLeft, bottomRight);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

export function createSunHoursOverlay(analysisResult, exaggeration = 1) {
  const geometry = createHeatmapGeometry(analysisResult);

  const fillMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.94,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const fillMesh = new THREE.Mesh(geometry, fillMaterial);
  fillMesh.renderOrder = 8;

  const wireframeMaterial = new THREE.LineBasicMaterial({
    color: "#09111c",
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    depthTest: false,
  });
  const wireframe = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), wireframeMaterial);
  wireframe.renderOrder = 9;

  const overlay = new THREE.Group();
  overlay.name = "sun-hours-overlay";
  overlay.add(fillMesh);
  overlay.add(wireframe);
  overlay.scale.y = exaggeration;
  overlay.userData = {
    analysisResult,
  };

  return overlay;
}

export function updateSunHoursOverlay(overlay, exaggeration) {
  if (!overlay) {
    return;
  }

  overlay.scale.y = exaggeration;
}

export function disposeSunHoursOverlay(overlay) {
  if (!overlay) {
    return;
  }

  overlay.children.forEach((child) => {
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  });
}
