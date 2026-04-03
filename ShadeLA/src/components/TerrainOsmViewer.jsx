import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";

import { fetchDemWithFallback } from "../terrain-osm/api.js";
import { createGeoReference } from "../terrain-osm/geo.js";
import {
  applyVerticalExaggeration,
  createTerrainMesh,
  parseGeoTiff,
  updateTerrainMaterial,
} from "../terrain-osm/terrain.js";
import { createBuildingGroup, disposeBuildingGroup, fetchBuildingsGeoJson, updateBuildingDisplay } from "../terrain-osm/buildings.js";
import { createRoadGroup, disposeRoadGroup, fetchRoadGeoJson, updateRoadDisplay } from "../terrain-osm/roads.js";
import { createSunHoursOverlay, disposeSunHoursOverlay, updateSunHoursOverlay } from "../terrain-osm/analysis-visualize.js";
import { runDirectSunHoursAnalysis } from "../terrain-osm/analysis-api.js";

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function boundsFromAnalyze(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const west = Number(bbox[0]);
  const south = Number(bbox[1]);
  const east = Number(bbox[2]);
  const north = Number(bbox[3]);
  if (![west, south, east, north].every((x) => Number.isFinite(x))) return null;
  return { minLon: west, minLat: south, maxLon: east, maxLat: north };
}

function defaultBounds() {
  return {
    minLon: -118.326047,
    minLat: 34.077448,
    maxLon: -118.320577,
    maxLat: 34.082834,
  };
}

const TerrainOsmViewer = forwardRef(function TerrainOsmViewer({ options, onStatus }, ref) {
  const apiKey = import.meta.env.VITE_OPENTOPO_API_KEY;

  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);

  const terrainStateRef = useRef(null);
  const geoRefRef = useRef(null);
  const buildingFeaturesRef = useRef(null);
  const buildingGroupRef = useRef(null);
  const roadGroupRef = useRef(null);
  const analysisOverlayRef = useRef(null);
  const sunPathGroupRef = useRef(null);

  const selectedBuildingRef = useRef(null);
  const [selectedBuildingUi, setSelectedBuildingUi] = useState(null);
  const [selectedBuildingHeight, setSelectedBuildingHeight] = useState(0);
  const [selectedBuildingMenuPos, setSelectedBuildingMenuPos] = useState(null);
  const modifiedBuildingsRef = useRef(new Map());
  const [modifiedBuildingsUi, setModifiedBuildingsUi] = useState([]);

  const [drawMode, setDrawMode] = useState(false);
  const drawModeRef = useRef(false);
  const [drawStatus, setDrawStatus] = useState("");
  const [, forceDrawUiUpdate] = useState(0);
  const drawGroupRef = useRef(null);
  const drawStateRef = useRef({ polylines: [], current: [] });
  const currentLineRef = useRef(null);
  const previewLineRef = useRef(null);
  const raycasterRef = useRef(new THREE.Raycaster());

  const clampAngleDegrees = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    let out = n;
    while (out <= -180) out += 360;
    while (out > 180) out -= 360;
    return out;
  };

  const parseDate = (value) => {
    if (!value) return null;
    const [y, m, d] = String(value).split("-").map((part) => Number(part));
    if (![y, m, d].every((v) => Number.isFinite(v))) return null;
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  };

  const addDaysUtc = (date, days) => {
    const out = new Date(date.getTime());
    out.setUTCDate(out.getUTCDate() + days);
    return out;
  };

  const manualSolarPosition = (latitude, longitude, momentUtc) => {
    const dayOfYear =
      Math.floor((Date.UTC(momentUtc.getUTCFullYear(), momentUtc.getUTCMonth(), momentUtc.getUTCDate()) -
        Date.UTC(momentUtc.getUTCFullYear(), 0, 0)) /
        86400000) || 1;
    const fractionalHour = momentUtc.getUTCHours() + momentUtc.getUTCMinutes() / 60;
    const declination =
      (23.45 * Math.sin(((360 / 365) * (284 + dayOfYear) * Math.PI) / 180) * Math.PI) / 180;
    const hourAngle = ((15 * (fractionalHour - 12)) * Math.PI) / 180;
    const latitudeRad = (latitude * Math.PI) / 180;

    const altitude = Math.asin(
      Math.sin(latitudeRad) * Math.sin(declination) +
        Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle)
    );

    const azimuth = Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(latitudeRad) - Math.tan(declination) * Math.cos(latitudeRad)
    );

    const altitudeDeg = (altitude * 180) / Math.PI;
    const azimuthFromNorth = ((azimuth * 180) / Math.PI + 180) % 360;
    return { altitudeDeg, azimuthDeg: azimuthFromNorth };
  };

  const generateSunDirections = ({ latitude, longitude, analysisPeriod, timestepMinutes, northDegrees }) => {
    const startDate = parseDate(analysisPeriod?.start_date);
    const endDate = parseDate(analysisPeriod?.end_date);
    if (!startDate || !endDate) return [];

    const startHour = clampNumber(analysisPeriod?.start_hour ?? 0, 0, 23);
    const endHour = clampNumber(analysisPeriod?.end_hour ?? 23, 0, 23);
    const stepHours = clampNumber(Number(timestepMinutes) / 60, 1 / 60, 12);
    const north = clampAngleDegrees(northDegrees ?? 0);

    const out = [];
    for (let day = new Date(startDate.getTime()); day <= endDate; day = addDaysUtc(day, 1)) {
      for (let hour = startHour; hour <= endHour + 1e-9; hour += stepHours) {
        const wholeHour = Math.floor(hour);
        const minute = Math.round((hour - wholeHour) * 60);
        const moment = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), wholeHour, minute, 0));
        const { altitudeDeg, azimuthDeg } = manualSolarPosition(latitude, longitude, moment);
        if (altitudeDeg <= 0) continue;

        const altitudeRad = (altitudeDeg * Math.PI) / 180;
        const azimuthRad = ((azimuthDeg + north) * Math.PI) / 180;
        const horizontal = Math.cos(altitudeRad);
        const direction = new THREE.Vector3(
          Math.sin(azimuthRad) * horizontal,
          Math.sin(altitudeRad),
          -Math.cos(azimuthRad) * horizontal
        ).normalize();
        out.push({ direction, moment });
      }
    }
    return out;
  };

  const clearSunPath = () => {
    const scene = sceneRef.current;
    const group = sunPathGroupRef.current;
    if (!scene || !group) return;
    scene.remove(group);
    group.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => m.dispose?.());
      }
    });
    sunPathGroupRef.current = null;
  };

  const showSunPath = (settings) => {
    const scene = sceneRef.current;
    const terrainState = terrainStateRef.current;
    if (!scene || !terrainState?.mesh) {
      throw new Error("Generate terrain before showing sun path.");
    }

    const currentBounds = boundsRef.current;
    const latitude = (currentBounds.minLat + currentBounds.maxLat) / 2;
    const longitude = (currentBounds.minLon + currentBounds.maxLon) / 2;

    const vectors = generateSunDirections({
      latitude,
      longitude,
      analysisPeriod: settings?.analysisPeriod,
      timestepMinutes: settings?.timestep,
      northDegrees: settings?.north,
    });

    if (!vectors.length) {
      throw new Error("Sun path has no sun positions for the selected period.");
    }

    clearSunPath();

    const box = new THREE.Box3().setFromObject(terrainState.mesh);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const radius = Math.max(size.x, size.z, 1) * 0.55;
    const baseY = center.y + Math.max(size.y, 1) + radius * 0.25;

    const group = new THREE.Group();
    group.name = "sun-path";
    group.renderOrder = 15;

    const positions = new Float32Array(vectors.length * 3);
    for (let i = 0; i < vectors.length; i += 1) {
      const p = center.clone().setY(baseY).addScaledVector(vectors[i].direction, radius);
      positions[i * 3 + 0] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(lineGeo, lineMat);
    line.frustumCulled = false;

    const dotsGeo = new THREE.BufferGeometry();
    dotsGeo.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
    const dotsMat = new THREE.PointsMaterial({ color: 0xfef3c7, size: Math.max(1, radius * 0.012), sizeAttenuation: true });
    const dots = new THREE.Points(dotsGeo, dotsMat);
    dots.frustumCulled = false;

    group.add(line);
    group.add(dots);
    sunPathGroupRef.current = group;
    scene.add(group);
  };

  const [bounds, setBounds] = useState(() => defaultBounds());
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  const [localOptions, setLocalOptions] = useState(() => options ?? {});

  const generateRef = useRef(null);

  useEffect(() => {
    if (options && typeof options === "object") {
      setLocalOptions(options);
    }
  }, [options]);

  const displayOptions = useMemo(
    () => ({
      showTerrain: !!localOptions?.showTerrain,
      exaggeration: clampNumber(localOptions?.exaggeration ?? 1, 0, 20),
      wireframe: !!localOptions?.wireframe,
      colorMode: localOptions?.colorMode ?? "ramp",
      hillshadeEnabled: localOptions?.hillshadeEnabled ?? true,
    }),
    [localOptions]
  );

  const buildingOptions = useMemo(
    () => ({
      showBuildings: !!localOptions?.showBuildings,
      defaultFloorHeight: clampNumber(localOptions?.defaultFloorHeight ?? 3.2, 1, 10),
      defaultBuildingHeight: clampNumber(localOptions?.defaultBuildingHeight ?? 12, 1, 200),
      opacity: clampNumber(localOptions?.buildingOpacity ?? 0.65, 0, 1),
      exaggeration: clampNumber(localOptions?.exaggeration ?? 1, 0, 20),
    }),
    [localOptions]
  );

  const roadOptions = useMemo(
    () => ({
      showRoads: !!localOptions?.showRoads,
      widthScale: clampNumber(localOptions?.roadWidthScale ?? 1, 0.1, 8),
      opacity: clampNumber(localOptions?.roadOpacity ?? 0.7, 0, 1),
      exaggeration: clampNumber(localOptions?.exaggeration ?? 1, 0, 20),
    }),
    [localOptions]
  );

  function reportStatus(message) {
    if (typeof onStatus === "function") onStatus(message);
  }

  const clearSelectedBuilding = () => {
    const current = selectedBuildingRef.current;
    if (current?.mesh && current.originalMaterial) {
      try {
        current.mesh.material = current.originalMaterial;
      } catch {
        // ignore
      }
    }

    selectedBuildingRef.current = null;
    setSelectedBuildingUi(null);
    setSelectedBuildingHeight(0);
    setSelectedBuildingMenuPos(null);
  };

  const syncModifiedBuildingsUi = () => {
    const entries = Array.from(modifiedBuildingsRef.current.values());
    entries.sort((a, b) => {
      const ak = String(a.label ?? a.key ?? "");
      const bk = String(b.label ?? b.key ?? "");
      return ak.localeCompare(bk);
    });
    setModifiedBuildingsUi(entries);
  };

  const getBuildingKey = (meta) => {
    return (
      meta?.key ??
      meta?.feature?.id ??
      meta?.feature?.properties?.["@id"] ??
      meta?.feature?.properties?.id ??
      meta?.feature?.properties?.osm_id ??
      null
    );
  };

  const getBuildingLabel = (meta) => {
    const key = getBuildingKey(meta);
    if (!key) return "Building";
    const parts = String(key).split(/[/:]/g).filter(Boolean);
    const last = parts[parts.length - 1] ?? String(key);
    return `Building №${last}`;
  };

  const getMeshWorldAnchor = (mesh) => {
    if (!mesh) return null;
    if (!mesh.geometry?.boundingBox) {
      try {
        mesh.geometry?.computeBoundingBox?.();
      } catch {
        // ignore
      }
    }
    const bbox = mesh.geometry?.boundingBox;
    if (!bbox) return null;
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    return mesh.localToWorld(center);
  };

  const projectWorldToScreen = (world) => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const mount = mountRef.current;
    if (!camera || !renderer || !mount || !world) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const mountRect = mount.getBoundingClientRect();
    const v = world.clone().project(camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return null;

    const px = ((v.x + 1) / 2) * rect.width + (rect.left - mountRect.left);
    const py = ((-v.y + 1) / 2) * rect.height + (rect.top - mountRect.top);

    return { x: px, y: py };
  };

  const highlightSelectedBuilding = (mesh) => {
    if (!mesh) return;

    const baseMaterial = mesh.material;
    const highlight = baseMaterial?.clone ? baseMaterial.clone() : new THREE.MeshStandardMaterial({ color: 0xffd166 });
    try {
      if ("emissive" in highlight) {
        highlight.emissive = new THREE.Color(0x22c55e);
        highlight.emissiveIntensity = 0.45;
      }
      highlight.needsUpdate = true;
    } catch {
      // ignore
    }

    mesh.material = highlight;
  };

  const pickBuildingAtEvent = (ev) => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const group = buildingGroupRef.current;
    if (!camera || !renderer || !group) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    const ndc = new THREE.Vector2(x, y);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(group.children || [], true);
    if (!hits?.length) return null;

    const hit = hits.find((h) => h.object?.userData?.building);
    return hit?.object ?? null;
  };

  const selectBuildingMesh = (mesh) => {
    if (!mesh?.userData?.building) {
      clearSelectedBuilding();
      return;
    }

    clearSelectedBuilding();

    selectedBuildingRef.current = {
      mesh,
      originalMaterial: mesh.material,
    };
    highlightSelectedBuilding(mesh);

    const meta = mesh.userData.building;
    const height = Number(meta?.height ?? 0);
    setSelectedBuildingHeight(Number.isFinite(height) ? height : 0);
    setSelectedBuildingUi({
      height: Number.isFinite(height) ? height : 0,
      key: getBuildingKey(meta),
      label: getBuildingLabel(meta),
    });
  };

  const rebuildSelectedBuildingHeight = (nextHeight) => {
    const current = selectedBuildingRef.current;
    const mesh = current?.mesh;
    if (!mesh?.userData?.building) return;

    const meta = mesh.userData.building;
    const shape = meta.shape;
    const baseElevation = Number(meta.baseElevation ?? 0);
    const minHeight = Number(meta.minHeight ?? 0);
    const height = Math.max(0.5, Number(nextHeight));
    if (!Number.isFinite(height)) return;

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, baseElevation + minHeight, 0);
    geometry.computeVertexNormals();

    try {
      mesh.geometry?.dispose?.();
    } catch {
      // ignore
    }
    mesh.geometry = geometry;

    mesh.userData.building = {
      ...meta,
      height,
    };

    try {
      if (meta.feature?.properties) {
        meta.feature.properties.height = String(height);
      }
    } catch {
      // ignore
    }
  };

  const getBuildingMeshesByKey = (key) => {
    const group = buildingGroupRef.current;
    if (!group || !key) return [];
    const meshes = [];
    group.traverse((obj) => {
      if (!obj?.isMesh) return;
      const k = obj?.userData?.building?.key;
      if (k === key) meshes.push(obj);
    });
    return meshes;
  };

  const rebuildBuildingHeightByKey = (key, nextHeight) => {
    const meshes = getBuildingMeshesByKey(key);
    meshes.forEach((m) => rebuildBuildingMeshHeight(m, nextHeight));
  };

  const rebuildBuildingMeshHeight = (mesh, nextHeight) => {
    if (!mesh?.userData?.building) return;
    const meta = mesh.userData.building;
    const shape = meta.shape;
    const baseElevation = Number(meta.baseElevation ?? 0);
    const minHeight = Number(meta.minHeight ?? 0);
    const height = Math.max(0.5, Number(nextHeight));
    if (!Number.isFinite(height) || !shape) return;

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, baseElevation + minHeight, 0);
    geometry.computeVertexNormals();

    try {
      mesh.geometry?.dispose?.();
    } catch {
      // ignore
    }
    mesh.geometry = geometry;

    mesh.userData.building = {
      ...meta,
      height,
    };

    try {
      if (meta.feature?.properties) {
        meta.feature.properties.height = String(height);
      }
    } catch {
      // ignore
    }
  };

  const markBuildingModified = (mesh, meta, currentHeight) => {
    const key = getBuildingKey(meta);
    if (!key) return;

    const existing = modifiedBuildingsRef.current.get(key);
    if (existing) {
      existing.currentHeight = currentHeight;
    } else {
      const originalHeight = Number(meta?.originalHeight ?? meta?.height ?? 0);
      modifiedBuildingsRef.current.set(key, {
        key,
        label: getBuildingLabel(meta),
        originalHeight: Number.isFinite(originalHeight) ? originalHeight : 0,
        currentHeight,
      });
    }
    syncModifiedBuildingsUi();
  };

  const revertModifiedBuilding = (key) => {
    const entry = modifiedBuildingsRef.current.get(key);
    if (!entry) return;

    rebuildBuildingHeightByKey(key, entry.originalHeight);

    const selected = selectedBuildingRef.current?.mesh;
    if (selected && selected?.userData?.building?.key === key) {
      setSelectedBuildingHeight(entry.originalHeight);
      setSelectedBuildingUi((prev) => (prev ? { ...prev, height: entry.originalHeight } : prev));
    }

    modifiedBuildingsRef.current.delete(key);
    syncModifiedBuildingsUi();
  };

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = window.requestAnimationFrame(tick);
      const mesh = selectedBuildingRef.current?.mesh;
      if (!mesh) return;
      const anchor = getMeshWorldAnchor(mesh);
      const pos = projectWorldToScreen(anchor);
      if (!pos) return;
      setSelectedBuildingMenuPos((prev) => {
        if (!prev) return pos;
        const dx = Math.abs(prev.x - pos.x);
        const dy = Math.abs(prev.y - pos.y);
        if (dx < 0.5 && dy < 0.5) return prev;
        return pos;
      });
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, []);

  function resizeRenderer() {
    const mount = mountRef.current;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!mount || !renderer || !camera) return;

    const w = Math.max(1, mount.clientWidth);
    const h = Math.max(1, mount.clientHeight);

    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, true);
  }

  const clearGroup = (group) => {
    if (!group) return;
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose?.();
      }
    });
  };

  const buildLineGeometry = (pts) => {
    const positions = new Array(pts.length * 3);
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      positions[i * 3 + 0] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }
    const geo = new LineGeometry();
    geo.setPositions(positions);
    return geo;
  };

  const syncLineMaterialResolution = (material) => {
    const renderer = rendererRef.current;
    if (!material || !renderer) return;
    const size = new THREE.Vector2();
    renderer.getSize(size);
    if (material.resolution) {
      material.resolution.set(Math.max(1, size.x), Math.max(1, size.y));
    }
  };

  const updateCurrentLine = () => {
    const current = drawStateRef.current.current;
    if (!drawGroupRef.current) return;

    if (currentLineRef.current) {
      drawGroupRef.current.remove(currentLineRef.current);
      currentLineRef.current.geometry?.dispose?.();
      currentLineRef.current.material?.dispose?.();
      currentLineRef.current = null;
    }

    if (current.length < 2) return;
    const geo = buildLineGeometry(current);
    const mat = new LineMaterial({
      color: 0x22c55e,
      linewidth: 3.5,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    syncLineMaterialResolution(mat);
    const line = new Line2(geo, mat);
    line.renderOrder = 60;
    line.frustumCulled = false;
    currentLineRef.current = line;
    drawGroupRef.current.add(line);
  };

  const updatePreviewLine = (mousePt) => {
    const current = drawStateRef.current.current;
    if (!drawGroupRef.current) return;

    if (previewLineRef.current) {
      drawGroupRef.current.remove(previewLineRef.current);
      previewLineRef.current.geometry?.dispose?.();
      previewLineRef.current.material?.dispose?.();
      previewLineRef.current = null;
    }

    if (!mousePt || current.length < 1) return;
    const pts = [...current, mousePt];
    const geo = buildLineGeometry(pts);
    const mat = new LineMaterial({
      color: 0x93c5fd,
      linewidth: 3.0,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
      dashed: true,
      dashScale: 1,
      dashSize: 0.7,
      gapSize: 0.45,
    });
    syncLineMaterialResolution(mat);
    const line = new Line2(geo, mat);
    line.renderOrder = 60;
    line.computeLineDistances();
    line.frustumCulled = false;
    previewLineRef.current = line;
    drawGroupRef.current.add(line);
  };

  const screenToPointOnTerrain = (ev) => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!camera || !renderer || !scene) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    const ndc = new THREE.Vector2(x, y);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(ndc, camera);

    const terrainMesh = terrainStateRef.current?.mesh ?? null;
    if (terrainMesh) {
      const hits = raycaster.intersectObject(terrainMesh, true);
      if (hits?.length) {
        const exaggeration = clampNumber(displayOptions?.exaggeration ?? 1, 0.0001, 1000);
        const pt = hits[0].point.clone();
        pt.y = pt.y / exaggeration;
        pt.y += 0.18 / exaggeration;
        return pt;
      }
    }

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const out = new THREE.Vector3();
    const ok = raycaster.ray.intersectPlane(plane, out);
    if (!ok) return null;
    const exaggeration = clampNumber(displayOptions?.exaggeration ?? 1, 0.0001, 1000);
    out.y += 0.18 / exaggeration;
    return out.clone();
  };

  function clearAnalysis() {
    const scene = sceneRef.current;
    const overlay = analysisOverlayRef.current;
    if (!scene || !overlay) return;

    scene.remove(overlay);
    disposeSunHoursOverlay(overlay);
    analysisOverlayRef.current = null;
  }

  function disposeTerrainAndLayers() {
    const scene = sceneRef.current;
    if (!scene) return;

    clearAnalysis();

    if (roadGroupRef.current) {
      scene.remove(roadGroupRef.current);
      disposeRoadGroup(roadGroupRef.current);
      roadGroupRef.current = null;
    }

    if (buildingGroupRef.current) {
      scene.remove(buildingGroupRef.current);
      disposeBuildingGroup(buildingGroupRef.current);
      buildingGroupRef.current = null;
    }

    const terrainState = terrainStateRef.current;
    if (terrainState) {
      scene.remove(terrainState.mesh);
      terrainState.geometry?.dispose?.();
      terrainState.material?.map?.dispose?.();
      terrainState.material?.dispose?.();
      terrainStateRef.current = null;
    }

    if (drawGroupRef.current) {
      scene.remove(drawGroupRef.current);
      clearGroup(drawGroupRef.current);
      drawGroupRef.current = null;
    }

    drawStateRef.current = { polylines: [], current: [] };
    currentLineRef.current = null;
    previewLineRef.current = null;
    setDrawStatus("");

    geoRefRef.current = null;
  }

  function frameScene() {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const items = [];
    if (terrainStateRef.current?.mesh) items.push(terrainStateRef.current.mesh);
    if (buildingGroupRef.current) items.push(buildingGroupRef.current);
    if (roadGroupRef.current) items.push(roadGroupRef.current);
    if (!items.length) return;

    const box = new THREE.Box3();
    items.forEach((obj) => box.expandByObject(obj));
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = (camera.fov * Math.PI) / 180;
    const fitHeightDistance = maxDim / (2 * Math.tan(fov / 2));
    const fitWidthDistance = fitHeightDistance / camera.aspect;
    const distance = 1.35 * Math.max(fitHeightDistance, fitWidthDistance);

    const direction = new THREE.Vector3(1, 0.85, 1).normalize();
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(0.1, distance / 2000);
    camera.far = Math.max(10000, distance * 10);
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
  }

  async function generate({ includeOsmLayers }) {
    const scene = sceneRef.current;
    if (!scene) return;

    const currentBounds = boundsRef.current;

    try {
      reportStatus("Requesting DEM...");
      disposeTerrainAndLayers();

      const result = await fetchDemWithFallback(currentBounds, apiKey, reportStatus);

      reportStatus("Parsing GeoTIFF...");
      const parsed = await parseGeoTiff(result.arrayBuffer);

      const geoReference = createGeoReference(currentBounds, parsed.width, parsed.height);
      geoRefRef.current = geoReference;

      const meshResult = createTerrainMesh(parsed, geoReference.terrainWidth, geoReference.terrainDepth);

      const terrainState = {
        ...meshResult,
        parsedTerrain: parsed,
        raster: parsed.raster,
        width: parsed.width,
        height: parsed.height,
        terrainWidth: geoReference.terrainWidth,
        terrainDepth: geoReference.terrainDepth,
        minElevation: parsed.minElevation,
        maxElevation: parsed.maxElevation,
      };

      terrainStateRef.current = terrainState;

      updateTerrainMaterial(terrainState, {
        colorMode: displayOptions.colorMode,
        hillshadeEnabled: displayOptions.hillshadeEnabled,
        exaggeration: displayOptions.exaggeration,
        wireframe: displayOptions.wireframe,
      });

      applyVerticalExaggeration(terrainState, displayOptions.exaggeration);
      terrainState.mesh.visible = !!displayOptions.showTerrain;

      scene.add(terrainState.mesh);
      frameScene();

      if (includeOsmLayers) {
        reportStatus("Fetching OSM buildings...");
        const buildingFeatures = await fetchBuildingsGeoJson(currentBounds, reportStatus);
        buildingFeaturesRef.current = buildingFeatures;
        const bGroup = createBuildingGroup(buildingFeatures, parsed, geoReference, buildingOptions);
        buildingGroupRef.current = bGroup;
        scene.add(bGroup);

        reportStatus("Fetching OSM roads...");
        const roadFeatures = await fetchRoadGeoJson(currentBounds, reportStatus);
        const rGroup = createRoadGroup(roadFeatures, parsed, geoReference, roadOptions);
        roadGroupRef.current = rGroup;
        scene.add(rGroup);

        frameScene();

        reportStatus("Terrain + OSM ready");
      } else {
        reportStatus("Terrain ready");
      }
    } catch (e) {
      reportStatus(`Error: ${String(e?.message || e)}`);
    }
  }

  generateRef.current = generate;

  useImperativeHandle(
    ref,
    () => ({
      setOptions(nextOptions) {
        if (!nextOptions || typeof nextOptions !== "object") return;
        setLocalOptions(nextOptions);
      },
      setBounds(nextBounds, { fit } = {}) {
        if (!nextBounds) return;
        const normalized = { ...nextBounds };
        boundsRef.current = normalized;
        setBounds(normalized);
        if (fit) {
          // framing is based on terrain; if no terrain yet, nothing to do.
        }
      },
      getBounds() {
        return boundsRef.current;
      },
      async generateTerrain() {
        await generate({ includeOsmLayers: false });
      },
      async generateTerrainAndOsm() {
        await generate({ includeOsmLayers: true });
      },
      frame() {
        frameScene();
      },
      clearSolar() {
        clearAnalysis();
      },
      async runSolarAnalysis(settings, { epwStationId } = {}) {
        const terrainState = terrainStateRef.current;
        const geoReference = geoRefRef.current;
        const buildingFeatures = buildingFeaturesRef.current || [];

        if (!terrainState || !geoReference) {
          throw new Error("Generate terrain (and buildings) before running solar analysis.");
        }

        const result = await runDirectSunHoursAnalysis({
          bounds: boundsRef.current,
          terrainState,
          buildingFeatures,
          geoReference,
          buildingOptions,
          settings,
          epwStationId,
        });

        const scene = sceneRef.current;
        if (scene) {
          clearAnalysis();
          const overlay = createSunHoursOverlay(result, displayOptions.exaggeration);
          analysisOverlayRef.current = overlay;
          scene.add(overlay);
        }

        return result;
      },
      setSolarOverlay(result) {
        const scene = sceneRef.current;
        const terrainState = terrainStateRef.current;
        if (!scene || !terrainState || !result) return;
        clearAnalysis();
        const overlay = createSunHoursOverlay(result, displayOptions.exaggeration);
        analysisOverlayRef.current = overlay;
        scene.add(overlay);
      },
      showSunPath(settings) {
        showSunPath(settings);
      },
      clearSunPath() {
        clearSunPath();
      },
    }),
    [displayOptions]
  );

  // init three
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0a121e");

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500000);
    camera.position.set(500, 350, 500);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dollySpeed = 0.85;
    if ("zoomToCursor" in controls) {
      controls.zoomToCursor = true;
    }
    controls.target.set(0, 10, 0);

    scene.add(new THREE.AmbientLight("#ffffff", 1.05));
    const directionalLight = new THREE.DirectionalLight("#fff6db", 2.0);
    directionalLight.position.set(80, 120, 60);
    scene.add(directionalLight);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;

    const drawGroup = new THREE.Group();
    drawGroup.name = "drawings";
    drawGroup.renderOrder = 20;
    drawGroupRef.current = drawGroup;
    scene.add(drawGroup);

    let raf = 0;
    const animate = () => {
      raf = window.requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => resizeRenderer();
    window.addEventListener("resize", onResize);

    let resizeObserver = null;
    try {
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => resizeRenderer());
        resizeObserver.observe(mount);
      }
    } catch {
      resizeObserver = null;
    }

    resizeRenderer();

    return () => {
      window.removeEventListener("resize", onResize);
      try {
        resizeObserver?.disconnect?.();
      } catch {
        // ignore
      }
      window.cancelAnimationFrame(raf);

      disposeTerrainAndLayers();

      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();

      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (drawMode) {
      controls.enableRotate = false;
      controls.enablePan = false;
      controls.enableZoom = true;
    } else {
      controls.enableRotate = true;
      controls.enablePan = true;
      controls.enableZoom = true;
    }
  }, [drawMode]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = renderer?.domElement;
    if (!canvas) return;

    const handleMouseDown = (ev) => {
      if (!drawModeRef.current) {
        return;
      }
      if (ev.button !== 0) {
        return;
      }
      ev.preventDefault();
      const pt = screenToPointOnTerrain(ev);
      if (!pt) {
        setDrawStatus("Draw: no intersection");
        return;
      }
      drawStateRef.current.current.push(pt);
      setDrawStatus(`Draw: ${drawStateRef.current.current.length} pts`);
      updateCurrentLine();
      updatePreviewLine(pt);
      forceDrawUiUpdate((x) => x + 1);
    };

    const handleMouseMove = (ev) => {
      if (!drawModeRef.current) return;
      const pt = screenToPointOnTerrain(ev);
      updatePreviewLine(pt);
    };

    const handleDoubleClick = (ev) => {
      if (drawModeRef.current) {
        return;
      }
      const mesh = pickBuildingAtEvent(ev);
      if (!mesh) {
        clearSelectedBuilding();
        return;
      }
      selectBuildingMesh(mesh);
    };

    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("dblclick", handleDoubleClick);
    return () => {
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("dblclick", handleDoubleClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishCurrentPolyline = () => {
    const current = drawStateRef.current.current;
    if (current.length < 2) return;

    drawStateRef.current.polylines.push(current.map((p) => p.clone()));
    drawStateRef.current.current = [];

    if (currentLineRef.current && drawGroupRef.current) {
      const finalLine = currentLineRef.current;
      currentLineRef.current = null;
      try {
        finalLine.material?.dispose?.();
        finalLine.material = new THREE.LineBasicMaterial({ color: 0x60a5fa });
      } catch {
        // ignore
      }
    }

    if (previewLineRef.current && drawGroupRef.current) {
      drawGroupRef.current.remove(previewLineRef.current);
      previewLineRef.current.geometry?.dispose?.();
      previewLineRef.current.material?.dispose?.();
      previewLineRef.current = null;
    }

    setDrawStatus("Draw: polyline saved");
    forceDrawUiUpdate((x) => x + 1);
  };

  const undoDraw = () => {
    const current = drawStateRef.current.current;
    if (current.length > 0) {
      current.pop();
      updateCurrentLine();
      forceDrawUiUpdate((x) => x + 1);
      return;
    }

    const lines = drawStateRef.current.polylines;
    if (!lines.length || !drawGroupRef.current) return;

    const last = drawGroupRef.current.children
      .slice()
      .reverse()
      .find((c) => c && c.type === "Line");
    if (last) {
      drawGroupRef.current.remove(last);
      last.geometry?.dispose?.();
      last.material?.dispose?.();
    }
    lines.pop();
    forceDrawUiUpdate((x) => x + 1);
  };

  const clearAllDrawings = () => {
    drawStateRef.current.polylines = [];
    drawStateRef.current.current = [];
    if (drawGroupRef.current) {
      clearGroup(drawGroupRef.current);
      drawGroupRef.current.clear();
    }
    currentLineRef.current = null;
    previewLineRef.current = null;
    setDrawStatus("");
    forceDrawUiUpdate((x) => x + 1);
  };

  // apply display options changes
  useEffect(() => {
    const terrainState = terrainStateRef.current;
    if (terrainState) {
      terrainState.mesh.visible = !!displayOptions.showTerrain;
      updateTerrainMaterial(terrainState, {
        colorMode: displayOptions.colorMode,
        hillshadeEnabled: displayOptions.hillshadeEnabled,
        exaggeration: displayOptions.exaggeration,
        wireframe: displayOptions.wireframe,
      });
      applyVerticalExaggeration(terrainState, displayOptions.exaggeration);
    }

    if (buildingGroupRef.current) {
      updateBuildingDisplay(buildingGroupRef.current, buildingOptions);
    }

    if (roadGroupRef.current) {
      updateRoadDisplay(roadGroupRef.current, roadOptions);
    }

    if (analysisOverlayRef.current) {
      updateSunHoursOverlay(analysisOverlayRef.current, displayOptions.exaggeration);
    }

    if (drawGroupRef.current) {
      drawGroupRef.current.scale.y = displayOptions.exaggeration;
    }
  }, [displayOptions, buildingOptions, roadOptions]);

  // listen for Analyze events and auto-generate terrain+OSM
  useEffect(() => {
    const handler = (event) => {
      const data = event?.data;
      if (!data) return;
      if (data.type !== "cadmapper:analyze") return;
      const next = boundsFromAnalyze(data.bbox);
      if (!next) return;
      setBounds(next);
      reportStatus("Analyze received: generating terrain + OSM...");
      // wait a tick so boundsRef updates
      window.setTimeout(() => {
        generateRef.current({ includeOsmLayers: true });
      }, 0);
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentPts = drawStateRef.current.current.length;
  const totalFinal = drawStateRef.current.polylines.length;

  return (
    <div
      ref={mountRef}
      style={{ position: "relative", width: "100%", height: "100%", background: "#0a121e", overflow: "hidden" }}
    >
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          padding: "10px 12px",
          borderRadius: 10,
          background: "rgba(10, 18, 30, 0.65)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(230,240,255,0.95)",
          backdropFilter: "blur(6px)",
          zIndex: 5,
          pointerEvents: "auto",
          userSelect: "none",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={() => {
            const next = !drawModeRef.current;
            drawModeRef.current = next;
            setDrawMode(next);
            setDrawStatus(next ? "Draw: click to add points" : "");
          }}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: drawMode ? "rgba(34,197,94,0.85)" : "rgba(17,24,39,0.8)",
            color: "#e5e7eb",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {drawMode ? "Draw: ON" : "Draw: OFF"}
        </button>

        <button
          type="button"
          onClick={finishCurrentPolyline}
          disabled={currentPts < 2}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(59,130,246,0.85)",
            color: "#e5e7eb",
            cursor: currentPts >= 2 ? "pointer" : "not-allowed",
            opacity: currentPts >= 2 ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          Finish
        </button>

        <button
          type="button"
          onClick={undoDraw}
          disabled={currentPts === 0 && totalFinal === 0}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(17,24,39,0.8)",
            color: "#e5e7eb",
            cursor: currentPts > 0 || totalFinal > 0 ? "pointer" : "not-allowed",
            opacity: currentPts > 0 || totalFinal > 0 ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          Undo
        </button>

        <button
          type="button"
          onClick={clearAllDrawings}
          disabled={currentPts === 0 && totalFinal === 0}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(239,68,68,0.85)",
            color: "#e5e7eb",
            cursor: currentPts > 0 || totalFinal > 0 ? "pointer" : "not-allowed",
            opacity: currentPts > 0 || totalFinal > 0 ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          Clear
        </button>

        <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "nowrap" }}>lines: {totalFinal} | points: {currentPts}</div>
        {drawStatus ? (
          <div style={{ fontSize: 12, opacity: 0.9, flexBasis: "100%" }}>{drawStatus}</div>
        ) : null}
      </div>

      {selectedBuildingUi ? (
        <div
          style={{
            position: "absolute",
            left: selectedBuildingMenuPos?.x ?? 10,
            top: selectedBuildingMenuPos?.y ?? 10,
            transform: "translate(-50%, calc(-100% - 14px))",
            zIndex: 5,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255, 255, 255, 0.18)",
            background: "rgba(10, 18, 30, 0.72)",
            color: "rgba(255, 255, 255, 0.95)",
            minWidth: 220,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{selectedBuildingUi.label ?? "Building"}</div>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            height (m)
            <input
              type="number"
              step="0.5"
              value={selectedBuildingHeight}
              onChange={(e) => setSelectedBuildingHeight(e.target.value)}
              style={{
                padding: "6px 8px",
                borderRadius: 10,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(0, 0, 0, 0.25)",
                color: "#e5e7eb",
                outline: "none",
              }}
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                const h = Number(selectedBuildingHeight);
                if (!Number.isFinite(h)) return;
                const mesh = selectedBuildingRef.current?.mesh;
                const key = mesh?.userData?.building?.key;
                if (key) {
                  rebuildBuildingHeightByKey(key, h);
                } else {
                  rebuildSelectedBuildingHeight(h);
                }
                if (mesh?.userData?.building) {
                  markBuildingModified(mesh, mesh.userData.building, h);
                }
                setSelectedBuildingUi((prev) => (prev ? { ...prev, height: h } : { height: h }));
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(17, 24, 39, 0.8)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => clearSelectedBuilding()}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(17, 24, 39, 0.8)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {modifiedBuildingsUi?.length ? (
        <div
          style={{
            position: "absolute",
            right: 10,
            top: 10,
            zIndex: 5,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255, 255, 255, 0.18)",
            background: "rgba(10, 18, 30, 0.72)",
            color: "rgba(255, 255, 255, 0.95)",
            minWidth: 220,
            maxWidth: 280,
            pointerEvents: "auto",
          }}
        >
          <div style={{ fontWeight: 700 }}>Modified buildings</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {modifiedBuildingsUi.map((b) => (
              <div
                key={b.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "6px 8px",
                  borderRadius: 10,
                  border: "1px solid rgba(255, 255, 255, 0.12)",
                  background: "rgba(0, 0, 0, 0.18)",
                }}
              >
                <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.label ?? "Building"}
                </div>
                <button
                  type="button"
                  onClick={() => revertModifiedBuilding(b.key)}
                  title="Revert building"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.15)",
                    background: "rgba(239, 68, 68, 0.85)",
                    color: "#0b1220",
                    cursor: "pointer",
                    fontWeight: 900,
                    lineHeight: "24px",
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default TerrainOsmViewer;
