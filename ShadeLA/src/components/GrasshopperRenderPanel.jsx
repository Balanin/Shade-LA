import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { VertexNormalsHelper } from "three/examples/jsm/helpers/VertexNormalsHelper.js";
import rhino3dm from "rhino3dm/rhino3dm.module.js";
import rhino3dmWasmUrl from "rhino3dm/rhino3dm.wasm?url";

class OBJParser {
  static parseOBJ(text) {
    const vertices = [];
    const faces = [];

    const lines = String(text || "").split("\n");

    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed || lineTrimmed.startsWith("#")) continue;

      const parts = lineTrimmed.split(/\s+/);
      const type = parts[0];

      switch (type) {
        case "v":
          vertices.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
          break;

        case "f": {
          const face = [];
          for (let i = 1; i < parts.length; i++) {
            const vertexIndex = parseInt(parts[i].split("/")[0], 10) - 1;
            face.push(vertexIndex);
          }

          for (let i = 1; i < face.length - 1; i++) {
            faces.push(face[0], face[i], face[i + 1]);
          }
          break;
        }

        default:
          break;
      }
    }

    return { vertices, faces };
  }

  static createGeometry(data) {
    const geometry = new THREE.BufferGeometry();

    const vertices = new Float32Array(data.vertices);
    const indices = new Uint32Array(data.faces);

    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    return geometry;
  }

  static getGeometryInfo(geometry) {
    const vertices = geometry.attributes.position.count;
    const faces = geometry.index.count / 3;
    const boundingBox = geometry.boundingBox;

    return {
      vertices,
      faces,
      bounds: {
        min: boundingBox.min,
        max: boundingBox.max,
        size: boundingBox.max.clone().sub(boundingBox.min),
        center: boundingBox.getCenter(new THREE.Vector3()),
      },
    };
  }
}

function GrasshopperRenderPanel() {
  const [status, setStatus] = useState("Waiting for GH result…");
  const [lastError, setLastError] = useState("");
  const [lastObjText, setLastObjText] = useState("");
  const [autoExportRhOut, setAutoExportRhOut] = useState(false);
  const [rotDeg, setRotDeg] = useState({ x: -90, y: 0, z: 0 });
  const [showWireframe, setShowWireframe] = useState(false);
  const [showAxes, setShowAxes] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showNormals, setShowNormals] = useState(false);
  const [meshColor, setMeshColor] = useState("#4CAF50");
  const [opacity, setOpacity] = useState(1.0);

  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const meshRef = useRef(null);
  const wireframeRef = useRef(null);
  const pointCloudRef = useRef(null);
  const hullMeshRef = useRef(null);
  const curveGroupRef = useRef(null);
  const normalsHelperRef = useRef(null);
  const axesHelperRef = useRef(null);
  const gridHelperRef = useRef(null);
  const rafRef = useRef(0);
  const extractTokenRef = useRef(0);
  const viewCenterRef = useRef(new THREE.Vector3(0, 0, 0));
  const viewDistRef = useRef(50);
  const lastSchemaRef = useRef(null);
  const rhinoModuleRef = useRef(null);
  const lastRhOutReadyRef = useRef(null);
  const geoMeshGroupRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await rhino3dm({ locateFile: () => rhino3dmWasmUrl });
        if (cancelled) return;
        rhinoModuleRef.current = mod;
      } catch {
        if (cancelled) return;
        rhinoModuleRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const requestObjFromViewer = useMemo(() => {
    return async (include = null) => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setStatus("Exporting OBJ…");
      setLastError("");

      return new Promise((resolve) => {
        let done = false;

        const timeoutMs = 30000;

        const cleanup = () => {
          window.removeEventListener("grasshopper:obj", onObj);
        };

        const onObj = (ev) => {
          const detail = ev?.detail;
          if (!detail || detail.requestId !== requestId) return;
          done = true;
          cleanup();

          if (detail.ok && typeof detail.objText === "string" && detail.objText.trim()) {
            resolve({ ok: true, objText: detail.objText });
            return;
          }

          const msg = detail?.error ? String(detail.error) : "OBJ export failed";
          resolve({ ok: false, error: msg });
        };

        window.addEventListener("grasshopper:obj", onObj);
        window.dispatchEvent(new CustomEvent("grasshopper:request-obj", { detail: { requestId, include } }));

        window.setTimeout(() => {
          if (done) return;
          cleanup();
          resolve({ ok: false, error: "OBJ export timeout (viewer did not respond)" });
        }, timeoutMs);
      });
    };
  }, []);

  const waitForRhOutOverlay = useMemo(() => {
    return async ({ timeoutMs = 30000 } = {}) => {
      return new Promise((resolve) => {
        const cached = lastRhOutReadyRef.current;
        if (cached && String(cached.paramName || "") === "RH_OUT") {
          resolve({ ok: !!cached.ok, meshCount: cached.meshCount ?? 0, triCount: cached.triCount ?? 0, error: cached.error });
          return;
        }

        let done = false;

        const cleanup = () => {
          window.removeEventListener("grasshopper:overlay-ready", onReady);
        };

        const onReady = (ev) => {
          const detail = ev?.detail;
          if (!detail || String(detail.paramName || "") !== "RH_OUT") return;
          lastRhOutReadyRef.current = detail;
          done = true;
          cleanup();
          resolve({ ok: !!detail.ok, meshCount: detail.meshCount ?? 0, triCount: detail.triCount ?? 0, error: detail.error });
        };

        window.addEventListener("grasshopper:overlay-ready", onReady);
        window.setTimeout(() => {
          if (done) return;
          cleanup();
          resolve({ ok: false, meshCount: 0, triCount: 0, error: "Timed out waiting for RH_OUT overlay" });
        }, timeoutMs);
      });
    };
  }, []);

  const ensureInteractiveViewer = useMemo(() => {
    return () => {
      const mount = mountRef.current;
      if (!mount) return false;
      if (rendererRef.current && sceneRef.current && cameraRef.current && controlsRef.current) return true;

      const w = mount.clientWidth || 800;
      const h = mount.clientHeight || 500;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1a1a1a);

      const camera = new THREE.PerspectiveCamera(75, w / h, 0.1, 10000);
      camera.position.set(100, 100, 100);
      camera.up.set(0, 1, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(w, h, false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mount.innerHTML = "";
      mount.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.minPolarAngle = 0.05;
      controls.maxPolarAngle = Math.PI - 0.05;

      // Zoom towards mouse pointer (when supported by current three.js OrbitControls).
      // This makes wheel zoom feel much more natural for inspection.
      try {
        if ("zoomToCursor" in controls) controls.zoomToCursor = true;
      } catch {
        // ignore
      }

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
      scene.add(ambientLight);

      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(50, 100, 50);
      directionalLight.castShadow = true;
      directionalLight.shadow.camera.near = 0.1;
      directionalLight.shadow.camera.far = 1000;
      directionalLight.shadow.camera.left = -200;
      directionalLight.shadow.camera.right = 200;
      directionalLight.shadow.camera.top = 200;
      directionalLight.shadow.camera.bottom = -200;
      scene.add(directionalLight);

      const axesHelper = new THREE.AxesHelper(50);
      axesHelper.visible = !!showAxes;
      scene.add(axesHelper);
      axesHelperRef.current = axesHelper;

      const gridHelper = new THREE.GridHelper(500, 50, 0x444444, 0x222222);
      gridHelper.visible = !!showGrid;
      scene.add(gridHelper);
      gridHelperRef.current = gridHelper;

      rendererRef.current = renderer;
      sceneRef.current = scene;
      cameraRef.current = camera;
      controlsRef.current = controls;

      const curves = new THREE.Group();
      curves.name = "gh-curves";
      scene.add(curves);
      curveGroupRef.current = curves;

      const animate = () => {
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current || !controlsRef.current) return;
        controlsRef.current.update();
        rendererRef.current.render(sceneRef.current, cameraRef.current);
        rafRef.current = requestAnimationFrame(animate);
      };
      rafRef.current = requestAnimationFrame(animate);

      return true;
    };
  }, [showAxes, showGrid]);

  const setCurvesInViewer = useMemo(() => {
    return (schema) => {
      const ok = ensureInteractiveViewer();
      if (!ok) return false;

      const rhino = rhinoModuleRef.current;
      if (!rhino) return false;

      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      const group = curveGroupRef.current;
      if (!scene || !camera || !controls || !group) return false;

      // Match rotation controls used for OBJ rendering.
      try {
        group.rotation.x = THREE.MathUtils.degToRad(rotDeg.x);
        group.rotation.y = THREE.MathUtils.degToRad(rotDeg.y);
        group.rotation.z = THREE.MathUtils.degToRad(rotDeg.z);
      } catch {
        // ignore
      }

      while (group.children.length) {
        const child = group.children.pop();
        try {
          group.remove(child);
        } catch {
          // ignore
        }
        try {
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        } catch {
          // ignore
        }
      }

      const values = Array.isArray(schema?.values) ? schema.values : [];
      const lineMat = new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.9 });

      let any = false;
      let bbox = new THREE.Box3();
      let bboxInit = false;

      const sampleCurveToPoints = (crv) => {
        if (!crv) return [];
        try {
          if (typeof crv.toPolyline === "function") {
            const poly = crv.toPolyline(1.0, 0.1, 0.0, 0.0);
            if (poly && typeof poly.count === "number" && typeof poly.get === "function") {
              const out = [];
              for (let i = 0; i < poly.count; i++) {
                const p = poly.get(i);
                if (!p) continue;
                const x = Number(p.X ?? p.x);
                const y = Number(p.Y ?? p.y);
                const z = Number(p.Z ?? p.z);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                out.push(new THREE.Vector3(x, y, z));
              }
              if (out.length >= 2) return out;
            }
          }
        } catch {
          // ignore
        }

        const out = [];
        try {
          const domain = typeof crv.domain === "function" ? crv.domain() : null;
          const t0 = Number(domain?.t0 ?? domain?.T0 ?? 0);
          const t1 = Number(domain?.t1 ?? domain?.T1 ?? 1);
          const n = 64;
          for (let i = 0; i <= n; i++) {
            const t = t0 + ((t1 - t0) * i) / n;
            if (typeof crv.pointAt !== "function") break;
            const p = crv.pointAt(t);
            if (!p) continue;
            const x = Number(p.X ?? p.x);
            const y = Number(p.Y ?? p.y);
            const z = Number(p.Z ?? p.z);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            out.push(new THREE.Vector3(x, y, z));
          }
        } catch {
          // ignore
        }
        return out.length >= 2 ? out : [];
      };

      for (const tree of values) {
        const inner = tree?.InnerTree;
        if (!inner || typeof inner !== "object") continue;

        for (const branchKey of Object.keys(inner)) {
          const items = inner[branchKey];
          if (!Array.isArray(items)) continue;

          for (const item of items) {
            const type = item?.type;
            const data = item?.data;
            if (!type || data == null) continue;
            const tl = String(type).toLowerCase();
            const looksLikeCurve = tl.includes("curve") || tl.includes("line") || tl.includes("polyline");
            if (!looksLikeCurve) continue;

            let json = data;
            if (typeof json === "string") {
              try {
                json = JSON.parse(json);
              } catch {
                json = null;
              }
            }
            if (!json) continue;

            let obj = null;
            try {
              if (typeof rhino?.CommonObject?.decode === "function") obj = rhino.CommonObject.decode(json);
              else if (typeof rhino?.CommonObject?.fromJSON === "function") obj = rhino.CommonObject.fromJSON(json);
              else if (typeof rhino?.CommonObject?.FromJSON === "function") obj = rhino.CommonObject.FromJSON(json);
            } catch {
              obj = null;
            }
            if (!obj) continue;

            let crv = obj;
            try {
              if (typeof obj.toNurbsCurve === "function") crv = obj.toNurbsCurve();
            } catch {
              crv = obj;
            }

            const pts = sampleCurveToPoints(crv);
            if (pts.length < 2) continue;

            const pos = new Float32Array(pts.length * 3);
            for (let i = 0; i < pts.length; i++) {
              pos[i * 3 + 0] = pts[i].x;
              pos[i * 3 + 1] = pts[i].y;
              pos[i * 3 + 2] = pts[i].z;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
            geo.computeBoundingBox();
            const line = new THREE.Line(geo, lineMat);
            group.add(line);
            any = true;

            if (geo.boundingBox) {
              if (!bboxInit) {
                bbox.copy(geo.boundingBox);
                bboxInit = true;
              } else {
                bbox.union(geo.boundingBox);
              }
            }
          }
        }
      }

      if (!any || !bboxInit) return any;

      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const dist = maxDim * 1.35;
      viewCenterRef.current.copy(center);
      viewDistRef.current = dist;
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(center.x + dist, center.y + dist, center.z + dist);
      controls.target.copy(center);
      controls.minDistance = Math.max(0.01, maxDim * 0.05);
      controls.maxDistance = Math.max(10, dist * 50);
      controls.update();

      return any;
    };
  }, [ensureInteractiveViewer, rotDeg.x, rotDeg.y, rotDeg.z]);

  const setGeoInViewer = useMemo(() => {
    return (schema) => {
      const ok = ensureInteractiveViewer();
      if (!ok) return false;

      const rhino = rhinoModuleRef.current;
      if (!rhino) return false;

      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return false;

      if (geoMeshGroupRef.current) {
        try {
          scene.remove(geoMeshGroupRef.current);
        } catch {
          // ignore
        }
        try {
          geoMeshGroupRef.current.traverse((obj) => {
            obj.geometry?.dispose?.();
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) m?.dispose?.();
          });
        } catch {
          // ignore
        }
        geoMeshGroupRef.current = null;
      }

      const values = Array.isArray(schema?.values) ? schema.values : [];
      const geoTree = values.find((v) => String(v?.ParamName || "") === "geo" || String(v?.ParamName || "") === "Geo");
      const inner = geoTree?.InnerTree;
      if (!inner || typeof inner !== "object") return false;

      const group = new THREE.Group();
      group.name = "gh-geo";
      // Match rotation controls used for OBJ rendering.
      try {
        group.rotation.x = THREE.MathUtils.degToRad(rotDeg.x);
        group.rotation.y = THREE.MathUtils.degToRad(rotDeg.y);
        group.rotation.z = THREE.MathUtils.degToRad(rotDeg.z);
      } catch {
        // ignore
      }
      scene.add(group);
      geoMeshGroupRef.current = group;

      const mat = new THREE.MeshStandardMaterial({
        color: 0xff7a00,
        metalness: 0.1,
        roughness: 0.7,
        side: THREE.DoubleSide,
        transparent: opacity < 1.0,
        opacity,
      });

      const normalizeMeshList = (res) => {
        if (!res) return [];
        if (Array.isArray(res)) return res;
        if (typeof res.count === "number" && typeof res.get === "function") {
          const out = [];
          for (let i = 0; i < res.count; i++) out.push(res.get(i));
          return out;
        }
        if (typeof res.length === "number") return Array.from(res);
        return [];
      };

      const getMeshingParams = () => {
        try {
          const mp = rhino.MeshingParameters;
          if (!mp) return null;
          if (mp.default) return mp.default;
          if (mp.defaultParameters) return mp.defaultParameters;
          if (typeof mp.createDefault === "function") return mp.createDefault();
        } catch {
          // ignore
        }
        return null;
      };

      const getRenderMeshType = () => {
        const mt = rhino?.MeshType;
        if (!mt) return 0;
        return mt.Render ?? mt.render ?? mt.Analysis ?? mt.analysis ?? 0;
      };

      const tryMeshFromBrep = (brep) => {
        if (!brep) return [];
        const mp = getMeshingParams();
        const meshType = getRenderMeshType();

        try {
          const fn = rhino?.Mesh?.createFromBrep;
          if (typeof fn === "function") {
            const res = mp ? fn(brep, mp) : fn(brep);
            const meshes = normalizeMeshList(res);
            if (meshes.length) return meshes;
          }
        } catch {
          // ignore
        }

        try {
          if (typeof brep.getMeshes === "function") {
            const res = brep.getMeshes(meshType);
            const meshes = normalizeMeshList(res);
            if (meshes.length) return meshes;
          }
        } catch {
          // ignore
        }

        try {
          if (typeof brep.toBrep === "function") {
            const b2 = brep.toBrep();
            if (b2) return tryMeshFromBrep(b2);
          }
        } catch {
          // ignore
        }

        return [];
      };

      const tryGetMeshes = (obj, typeStr) => {
        if (!obj) return [];

        try {
          if (obj instanceof rhino.Mesh) return [obj];
        } catch {
          // ignore
        }

        try {
          if (obj instanceof rhino.Brep) return tryMeshFromBrep(obj);
        } catch {
          // ignore
        }

        try {
          if (typeof obj.toBrep === "function") {
            const brep = obj.toBrep();
            return tryMeshFromBrep(brep);
          }
        } catch {
          // ignore
        }

        const t = String(typeStr || "").toLowerCase();
        if (t.includes("brep")) return tryMeshFromBrep(obj);
        return [];
      };

      const vertexToXYZ = (v) => {
        if (!v) return [0, 0, 0];
        if (Array.isArray(v)) return [v[0], v[1], v[2]];
        if (typeof v === "object") {
          const x = v.x ?? v.X ?? v[0] ?? 0;
          const y = v.y ?? v.Y ?? v[1] ?? 0;
          const z = v.z ?? v.Z ?? v[2] ?? 0;
          return [x, y, z];
        }
        return [0, 0, 0];
      };

      const faceToIndices = (f) => {
        if (!f) return null;
        if (Array.isArray(f)) return { a: f[0], b: f[1], c: f[2], d: f[3] };
        if (typeof f === "object") {
          const a = f.a ?? f.A ?? f[0];
          const b = f.b ?? f.B ?? f[1];
          const c = f.c ?? f.C ?? f[2];
          const d = f.d ?? f.D ?? f[3];
          return { a, b, c, d };
        }
        return null;
      };

      let any = false;
      let bbox = new THREE.Box3();
      let bboxInit = false;

      for (const branchKey of Object.keys(inner)) {
        const items = inner[branchKey];
        if (!Array.isArray(items)) continue;

        for (const item of items) {
          const type = item?.type ?? item?.Type;
          const data = item?.data ?? item?.Data;
          if (!type || data == null) continue;

          let json = data;
          if (typeof json === "string") {
            try {
              json = JSON.parse(json);
            } catch {
              // ignore
            }
          }

          let obj = null;
          try {
            if (typeof rhino?.CommonObject?.decode === "function") obj = rhino.CommonObject.decode(json);
            else if (typeof rhino?.CommonObject?.fromJSON === "function") obj = rhino.CommonObject.fromJSON(json);
            else if (typeof rhino?.CommonObject?.FromJSON === "function") obj = rhino.CommonObject.FromJSON(json);
          } catch {
            obj = null;
          }
          if (!obj) continue;

          const meshes = tryGetMeshes(obj, type);
          for (const m of meshes || []) {
            try {
              const geo = new THREE.BufferGeometry();
              const verts = m.vertices();
              const vCount = verts.count;
              const pos = new Float32Array(vCount * 3);
              for (let i = 0; i < vCount; i++) {
                const v = verts.get(i);
                const xyz = vertexToXYZ(v);
                pos[i * 3 + 0] = xyz[0];
                pos[i * 3 + 1] = xyz[1];
                pos[i * 3 + 2] = xyz[2];
              }
              geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

              const faces = m.faces();
              const fCount = faces.count;
              const indices = [];
              for (let fi = 0; fi < fCount; fi++) {
                const raw = faces.get(fi);
                const f = faceToIndices(raw);
                if (!f) continue;
                const a = f.a;
                const b = f.b;
                const c = f.c;
                const d = f.d;
                if (d === undefined || d === null || d === c) {
                  indices.push(a, b, c);
                } else {
                  indices.push(a, b, c);
                  indices.push(a, c, d);
                }
              }
              geo.setIndex(indices);
              geo.computeVertexNormals();
              geo.computeBoundingBox();

              const mesh = new THREE.Mesh(geo, mat);
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              group.add(mesh);
              any = true;

              if (geo.boundingBox) {
                if (!bboxInit) {
                  bbox.copy(geo.boundingBox);
                  bboxInit = true;
                } else {
                  bbox.union(geo.boundingBox);
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }

      // Also try to draw curves if any (re-use the curve extractor on a schema filtered to geo).
      let anyCurves = false;
      try {
        anyCurves = !!setCurvesInViewer({ ...schema, values: [geoTree] });
      } catch {
        // ignore
      }

      // If we got curves but no meshes, that's still a valid render.
      if (!any && anyCurves) return true;

      if (!any || !bboxInit) return any;

      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const dist = maxDim * 1.35;
      viewCenterRef.current.copy(center);
      viewDistRef.current = dist;
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(center.x + dist, center.y + dist, center.z + dist);
      controls.target.copy(center);
      controls.minDistance = Math.max(0.01, maxDim * 0.05);
      controls.maxDistance = Math.max(10, dist * 50);
      controls.update();

      return true;
    };
  }, [ensureInteractiveViewer, opacity, rotDeg.x, rotDeg.y, rotDeg.z, setCurvesInViewer]);

  const setPointsInViewer = useMemo(() => {
    return (schema) => {
      const ok = ensureInteractiveViewer();
      if (!ok) return false;

      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return false;

      if (hullMeshRef.current) {
        try {
          scene.remove(hullMeshRef.current);
        } catch {
          // ignore
        }
        try {
          hullMeshRef.current.geometry?.dispose?.();
          hullMeshRef.current.material?.dispose?.();
        } catch {
          // ignore
        }
        hullMeshRef.current = null;
      }

      if (pointCloudRef.current) {
        try {
          scene.remove(pointCloudRef.current);
        } catch {
          // ignore
        }
        try {
          pointCloudRef.current.geometry?.dispose?.();
          pointCloudRef.current.material?.dispose?.();
        } catch {
          // ignore
        }
        pointCloudRef.current = null;
      }

      const values = Array.isArray(schema?.values) ? schema.values : [];
      const pts = [];
      for (const v of values) {
        const inner = v?.InnerTree;
        if (!inner || typeof inner !== "object") continue;
        for (const key of Object.keys(inner)) {
          const items = inner[key];
          if (!Array.isArray(items)) continue;
          for (const it of items) {
            const t = String(it?.type || "");
            if (!t.toLowerCase().includes("point3d")) continue;
            try {
              const d = typeof it.data === "string" ? JSON.parse(it.data) : it.data;
              const x = Number(d?.X);
              const y = Number(d?.Y);
              const z = Number(d?.Z);
              if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
              pts.push(x, y, z);
            } catch {
              // ignore
            }
          }
        }
      }

      if (!pts.length) return false;

      const vectorsAll = [];
      for (let i = 0; i < pts.length; i += 3) {
        vectorsAll.push(new THREE.Vector3(pts[i], pts[i + 1], pts[i + 2]));
      }

      const maxHullPoints = 2000;
      let vectors = vectorsAll;
      if (vectorsAll.length > maxHullPoints) {
        vectors = [];
        const step = Math.max(1, Math.floor(vectorsAll.length / maxHullPoints));
        for (let i = 0; i < vectorsAll.length; i += step) vectors.push(vectorsAll[i]);
      }

      if (vectors.length >= 4) {
        try {
          const hullGeom = new ConvexGeometry(vectors);
          hullGeom.computeVertexNormals();
          hullGeom.computeBoundingBox();
          const hullMat = new THREE.MeshPhongMaterial({
            color: 0xffd166,
            opacity: 0.85,
            transparent: true,
            side: THREE.DoubleSide,
          });
          const hullMesh = new THREE.Mesh(hullGeom, hullMat);
          hullMesh.castShadow = true;
          hullMesh.receiveShadow = true;
          scene.add(hullMesh);
          hullMeshRef.current = hullMesh;

          const box = hullGeom.boundingBox;
          if (box) {
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z) || 1;
            const dist = maxDim * 1.35;
            viewCenterRef.current.copy(center);
            viewDistRef.current = dist;
            camera.near = Math.max(0.01, maxDim / 1000);
            camera.far = Math.max(10000, maxDim * 20);
            camera.updateProjectionMatrix();
            camera.position.set(center.x + dist, center.y + dist, center.z + dist);
            controls.target.copy(center);
            controls.minDistance = Math.max(0.01, maxDim * 0.05);
            controls.maxDistance = Math.max(10, dist * 50);
            controls.update();
          }

          if (pointCloudRef.current) {
            try {
              scene.remove(pointCloudRef.current);
            } catch {
              // ignore
            }
            try {
              pointCloudRef.current.geometry?.dispose?.();
              pointCloudRef.current.material?.dispose?.();
            } catch {
              // ignore
            }
            pointCloudRef.current = null;
          }

          return true;
        } catch {
          // ignore
        }
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
      geom.computeBoundingBox();

      const mat = new THREE.PointsMaterial({ color: 0xffd166, size: 2, sizeAttenuation: true });
      const cloud = new THREE.Points(geom, mat);
      scene.add(cloud);
      pointCloudRef.current = cloud;

      const box = geom.boundingBox;
      if (box) {
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const dist = maxDim * 1.35;
        viewCenterRef.current.copy(center);
        viewDistRef.current = dist;
        camera.near = Math.max(0.01, maxDim / 1000);
        camera.far = Math.max(10000, maxDim * 20);
        camera.updateProjectionMatrix();
        camera.position.set(center.x + dist, center.y + dist, center.z + dist);
        controls.target.copy(center);
        controls.minDistance = Math.max(0.01, maxDim * 0.05);
        controls.maxDistance = Math.max(10, dist * 50);
        controls.update();
      }

      return true;
    };
  }, [ensureInteractiveViewer]);

  const syncNormalsHelper = useMemo(() => {
    return (nextShow) => {
      const scene = sceneRef.current;
      const mesh = meshRef.current;
      if (!scene) return;

      if (normalsHelperRef.current) {
        try {
          scene.remove(normalsHelperRef.current);
        } catch {
          // ignore
        }
        normalsHelperRef.current = null;
      }

      if (nextShow && mesh) {
        try {
          const helper = new VertexNormalsHelper(mesh, 10, 0xff0000);
          scene.add(helper);
          normalsHelperRef.current = helper;
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const renderObjToDataUrl = useMemo(() => {
    return (objText, width = 1280, height = 720) => {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1a1a1a);

      const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 10000);
      camera.position.set(100, 100, 100);

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
      scene.add(ambientLight);

      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(50, 100, 50);
      directionalLight.castShadow = true;
      directionalLight.shadow.camera.near = 0.1;
      directionalLight.shadow.camera.far = 1000;
      directionalLight.shadow.camera.left = -200;
      directionalLight.shadow.camera.right = 200;
      directionalLight.shadow.camera.top = 200;
      directionalLight.shadow.camera.bottom = -200;
      scene.add(directionalLight);

      const axesHelper = new THREE.AxesHelper(50);
      scene.add(axesHelper);

      const gridHelper = new THREE.GridHelper(500, 50, 0x444444, 0x222222);
      scene.add(gridHelper);

      const parsed = OBJParser.parseOBJ(objText);
      if (!parsed?.vertices?.length || !parsed?.faces?.length) {
        throw new Error("OBJ contains no vertices/faces");
      }
      const geometry = OBJParser.createGeometry(parsed);
      const info = OBJParser.getGeometryInfo(geometry);

      const mat = new THREE.MeshPhongMaterial({
        color: meshColor,
        opacity,
        transparent: opacity < 1.0,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, mat);

      mesh.castShadow = true;
      mesh.receiveShadow = true;

      mesh.rotation.x = THREE.MathUtils.degToRad(rotDeg.x);
      mesh.rotation.y = THREE.MathUtils.degToRad(rotDeg.y);
      mesh.rotation.z = THREE.MathUtils.degToRad(rotDeg.z);
      scene.add(mesh);

      // Use world-space bbox after rotation (and any future transforms) to fit camera.
      const worldBox = new THREE.Box3().setFromObject(mesh);
      const worldSize = worldBox.getSize(new THREE.Vector3());
      const worldCenter = worldBox.getCenter(new THREE.Vector3());

      const maxDim = Math.max(worldSize.x, worldSize.y, worldSize.z) || 1;
      const dist = maxDim * 2;
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(worldCenter.x + dist, worldCenter.y + dist, worldCenter.z + dist);
      camera.lookAt(worldCenter);

      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.render(scene, camera);

      const dataUrl = renderer.domElement.toDataURL("image/png");
      renderer.dispose?.();
      geometry.dispose?.();
      mat.dispose?.();

      return dataUrl;
    };
  }, [meshColor, opacity, rotDeg.x, rotDeg.y, rotDeg.z]);

  const setObjInViewer = useMemo(() => {
    return (objText) => {
      const ok = ensureInteractiveViewer();
      if (!ok) return;

      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return;

      if (meshRef.current) {
        try {
          scene.remove(meshRef.current);
        } catch {
          // ignore
        }
        try {
          meshRef.current.geometry?.dispose?.();
        } catch {
          // ignore
        }
        try {
          meshRef.current.material?.dispose?.();
        } catch {
          // ignore
        }
        meshRef.current = null;
      }

      if (wireframeRef.current) {
        try {
          scene.remove(wireframeRef.current);
        } catch {
          // ignore
        }
        try {
          wireframeRef.current.geometry?.dispose?.();
        } catch {
          // ignore
        }
        try {
          wireframeRef.current.material?.dispose?.();
        } catch {
          // ignore
        }
        wireframeRef.current = null;
      }

      if (normalsHelperRef.current) {
        try {
          scene.remove(normalsHelperRef.current);
        } catch {
          // ignore
        }
        normalsHelperRef.current = null;
      }

      const parsed = OBJParser.parseOBJ(objText);
      if (!parsed?.vertices?.length || !parsed?.faces?.length) {
        throw new Error("OBJ contains no vertices/faces");
      }

      const geometry = OBJParser.createGeometry(parsed);

      const mat = new THREE.MeshPhongMaterial({
        color: meshColor,
        opacity,
        transparent: opacity < 1.0,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geometry, mat);
      mesh.rotation.x = THREE.MathUtils.degToRad(rotDeg.x);
      mesh.rotation.y = THREE.MathUtils.degToRad(rotDeg.y);
      mesh.rotation.z = THREE.MathUtils.degToRad(rotDeg.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      meshRef.current = mesh;

      const wireframeMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
      });
      const wire = new THREE.Mesh(geometry.clone(), wireframeMaterial);
      wire.rotation.copy(mesh.rotation);
      wire.visible = !!showWireframe;
      scene.add(wire);
      wireframeRef.current = wire;

      if (showNormals) {
        syncNormalsHelper(true);
      }

      const worldBox = new THREE.Box3().setFromObject(mesh);
      const worldSize = worldBox.getSize(new THREE.Vector3());
      const worldCenter = worldBox.getCenter(new THREE.Vector3());
      const maxDim = Math.max(worldSize.x, worldSize.y, worldSize.z) || 1;

      const dist = maxDim * 1.35;
      viewCenterRef.current.copy(worldCenter);
      viewDistRef.current = dist;
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(worldCenter.x + dist, worldCenter.y + dist, worldCenter.z + dist);
      controls.target.copy(worldCenter);
      controls.minDistance = Math.max(0.01, maxDim * 0.05);
      controls.maxDistance = Math.max(10, dist * 50);
      controls.update();
    };
  }, [ensureInteractiveViewer, meshColor, opacity, rotDeg.x, rotDeg.y, rotDeg.z, showNormals, showWireframe, syncNormalsHelper]);

  const applyRotationToMesh = useMemo(() => {
    return (nextRotDeg) => {
      setRotDeg(nextRotDeg);

      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return;

      const rx = THREE.MathUtils.degToRad(nextRotDeg.x);
      const ry = THREE.MathUtils.degToRad(nextRotDeg.y);
      const rz = THREE.MathUtils.degToRad(nextRotDeg.z);

      const mesh = meshRef.current;
      if (mesh) {
        mesh.rotation.set(rx, ry, rz);
        mesh.updateMatrixWorld(true);
      }

      try {
        if (geoMeshGroupRef.current) {
          geoMeshGroupRef.current.rotation.set(rx, ry, rz);
          geoMeshGroupRef.current.updateMatrixWorld(true);
        }
      } catch {
        // ignore
      }

      try {
        if (curveGroupRef.current) {
          curveGroupRef.current.rotation.set(rx, ry, rz);
          curveGroupRef.current.updateMatrixWorld(true);
        }
      } catch {
        // ignore
      }

      if (wireframeRef.current && mesh) {
        wireframeRef.current.rotation.copy(mesh.rotation);
        wireframeRef.current.updateMatrixWorld(true);
      }

      if (showNormals) {
        try {
          syncNormalsHelper(true);
        } catch {
          // ignore
        }
      }

      // Refit camera to whatever geometry we have (OBJ mesh, geo meshes, or curves).
      const targetObj = mesh || geoMeshGroupRef.current || curveGroupRef.current;
      if (!targetObj) return;

      const worldBox = new THREE.Box3().setFromObject(targetObj);
      const worldSize = worldBox.getSize(new THREE.Vector3());
      const worldCenter = worldBox.getCenter(new THREE.Vector3());
      const maxDim = Math.max(worldSize.x, worldSize.y, worldSize.z) || 1;
      const dist = maxDim * 1.35;

      viewCenterRef.current.copy(worldCenter);
      viewDistRef.current = dist;
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(worldCenter.x + dist, worldCenter.y + dist, worldCenter.z + dist);
      controls.target.copy(worldCenter);
      controls.minDistance = Math.max(0.01, maxDim * 0.05);
      controls.maxDistance = Math.max(10, dist * 50);
      controls.update();
    };
  }, [showNormals, syncNormalsHelper]);

  const centerAndGround = useMemo(() => {
    return () => {
      const mesh = meshRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;

      // Prefer OBJ mesh if present (supports grounding). Otherwise fall back to geo/curves.
      const targetObj = mesh || geoMeshGroupRef.current || curveGroupRef.current;
      if (!targetObj) return;

      targetObj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(targetObj);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const dist = maxDim * 1.35;

      // If we have an OBJ mesh, also put it on the ground plane (minY = 0)
      // and re-center in X/Z so it sits nicely.
      if (mesh) {
        const minY = box.min.y;
        mesh.position.x += -center.x;
        mesh.position.z += -center.z;
        mesh.position.y += -minY;
        mesh.updateMatrixWorld(true);

        const box2 = new THREE.Box3().setFromObject(mesh);
        const center2 = box2.getCenter(new THREE.Vector3());
        const size2 = box2.getSize(new THREE.Vector3());
        const maxDim2 = Math.max(size2.x, size2.y, size2.z) || 1;
        const dist2 = maxDim2 * 1.35;

        viewCenterRef.current.copy(center2);
        viewDistRef.current = dist2;
        camera.near = Math.max(0.01, maxDim2 / 1000);
        camera.far = Math.max(10000, maxDim2 * 20);
        camera.updateProjectionMatrix();
        camera.position.set(center2.x + dist2, center2.y + dist2, center2.z + dist2);
        controls.target.copy(center2);
        controls.minDistance = Math.max(0.01, maxDim2 * 0.05);
        controls.maxDistance = Math.max(10, dist2 * 50);
        controls.update();
        return;
      }

      const geoGroup = geoMeshGroupRef.current;
      const curveGroup = curveGroupRef.current;

      // Center geometry onto the grid origin.
      const offset = center.clone().multiplyScalar(-1);
      try {
        if (geoGroup) geoGroup.position.add(offset);
      } catch {
        // ignore
      }
      try {
        if (curveGroup) curveGroup.position.add(offset);
      } catch {
        // ignore
      }

      try {
        geoGroup?.updateMatrixWorld?.(true);
      } catch {
        // ignore
      }
      try {
        curveGroup?.updateMatrixWorld?.(true);
      } catch {
        // ignore
      }

      // Ground to Y=0.
      const groundedBox = new THREE.Box3();
      let groundedInit = false;
      try {
        if (geoGroup) {
          groundedBox.copy(new THREE.Box3().setFromObject(geoGroup));
          groundedInit = true;
        }
      } catch {
        // ignore
      }
      try {
        if (curveGroup) {
          const cb = new THREE.Box3().setFromObject(curveGroup);
          if (!groundedInit) {
            groundedBox.copy(cb);
            groundedInit = true;
          } else {
            groundedBox.union(cb);
          }
        }
      } catch {
        // ignore
      }

      if (!groundedInit) return;

      const minY = groundedBox.min.y;
      try {
        if (geoGroup) geoGroup.position.y += -minY;
      } catch {
        // ignore
      }
      try {
        if (curveGroup) curveGroup.position.y += -minY;
      } catch {
        // ignore
      }

      try {
        geoGroup?.updateMatrixWorld?.(true);
      } catch {
        // ignore
      }
      try {
        curveGroup?.updateMatrixWorld?.(true);
      } catch {
        // ignore
      }

      // Fit camera to final bbox.
      const finalBox = new THREE.Box3();
      let finalInit = false;
      try {
        if (geoGroup) {
          finalBox.copy(new THREE.Box3().setFromObject(geoGroup));
          finalInit = true;
        }
      } catch {
        // ignore
      }
      try {
        if (curveGroup) {
          const cb = new THREE.Box3().setFromObject(curveGroup);
          if (!finalInit) {
            finalBox.copy(cb);
            finalInit = true;
          } else {
            finalBox.union(cb);
          }
        }
      } catch {
        // ignore
      }

      if (!finalInit) return;

      const center2 = finalBox.getCenter(new THREE.Vector3());
      const size2 = finalBox.getSize(new THREE.Vector3());
      const maxDim2 = Math.max(size2.x, size2.y, size2.z) || 1;
      const dist2 = maxDim2 * 1.35;

      viewCenterRef.current.copy(center2);
      viewDistRef.current = dist2;
      camera.near = Math.max(0.01, maxDim2 / 1000);
      camera.far = Math.max(10000, maxDim2 * 20);
      camera.updateProjectionMatrix();
      camera.position.set(center2.x + dist2, center2.y + dist2, center2.z + dist2);
      controls.target.copy(center2);
      controls.minDistance = Math.max(0.01, maxDim2 * 0.05);
      controls.maxDistance = Math.max(10, dist2 * 50);
      controls.update();
      return;
    };
  }, []);

  const applyViewPreset = useMemo(() => {
    return (kind) => {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;

      const c = viewCenterRef.current.clone();
      const dist = viewDistRef.current || 50;

      camera.up.set(0, 1, 0);

      if (kind === "top") {
        camera.position.set(c.x, c.y + dist, c.z);
      } else if (kind === "front") {
        camera.position.set(c.x, c.y, c.z + dist);
      } else {
        camera.position.set(c.x + dist, c.y + dist, c.z + dist);
      }

      controls.target.copy(c);
      controls.update();
    };
  }, []);

  useEffect(() => {
    ensureInteractiveViewer();

    const mount = mountRef.current;
    if (!mount) return;

    const ro = new ResizeObserver(() => {
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      if (!renderer || !camera) return;
      const w = mount.clientWidth || 800;
      const h = mount.clientHeight || 500;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });

    ro.observe(mount);

    return () => {
      try {
        ro.disconnect();
      } catch {
        // ignore
      }
    };
  }, [ensureInteractiveViewer]);

  useEffect(() => {
    if (!lastObjText) return;
    try {
      setObjInViewer(lastObjText);
    } catch (e) {
      setLastError(String(e?.message || e));
    }
  }, [lastObjText, setObjInViewer]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;

      try {
        if (meshRef.current && sceneRef.current) sceneRef.current.remove(meshRef.current);
      } catch {
        // ignore
      }
      try {
        meshRef.current?.geometry?.dispose?.();
      } catch {
        // ignore
      }
      try {
        meshRef.current?.material?.dispose?.();
      } catch {
        // ignore
      }
      meshRef.current = null;

      try {
        controlsRef.current?.dispose?.();
      } catch {
        // ignore
      }
      controlsRef.current = null;

      try {
        rendererRef.current?.dispose?.();
      } catch {
        // ignore
      }
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  const requestSnapshot = useMemo(() => {
    return async () => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setStatus("Rendering snapshot…");
      setLastError("");

      return new Promise((resolve) => {
        let done = false;

        const cleanup = () => {
          window.removeEventListener("grasshopper:render-snapshot", onSnap);
        };

        const onSnap = (ev) => {
          const detail = ev?.detail;
          if (!detail || detail.requestId !== requestId) return;
          done = true;
          cleanup();

          if (detail.ok && detail.dataUrl) {
            setImgUrl(detail.dataUrl);
            setStatus("Ready");
            resolve(true);
            return;
          }

          const msg = detail?.error ? String(detail.error) : "Snapshot failed";
          setLastError(msg);
          setStatus("Error");
          resolve(false);
        };

        window.addEventListener("grasshopper:render-snapshot", onSnap);
        window.dispatchEvent(
          new CustomEvent("grasshopper:request-render-snapshot", {
            detail: { requestId, overlayOnly: true, width: 1280, height: 720 },
          })
        );

        window.setTimeout(() => {
          if (done) return;
          cleanup();
          setLastError("Snapshot timeout (viewer did not respond)");
          setStatus("Error");
          resolve(false);
        }, 3000);
      });
    };
  }, []);

  const renderFromSchema = useMemo(() => {
    return async (schema, { exportObj = true } = {}) => {
      extractTokenRef.current += 1;
      const token = extractTokenRef.current;

      const filteredSchema = (() => {
        const values = schema?.values;
        if (!schema || !Array.isArray(values)) return schema;
        const wanted = new Set(["RH_OUT", "RH_OUT_JSON", "RH_READY", "RH_STATUS", "RH_META", "geo", "Geo"]);
        const only = values.filter((v) => wanted.has(String(v?.ParamName || "")));
        return { ...schema, values: only };
      })();

      lastSchemaRef.current = filteredSchema;

      if (token !== extractTokenRef.current) return false;

      try {
        const hasGeo = Array.isArray(filteredSchema?.values)
          ? filteredSchema.values.some((v) => String(v?.ParamName || "") === "geo" || String(v?.ParamName || "") === "Geo")
          : false;
        if (hasGeo) {
          setStatus("Rendering geo…");
          setLastError("");
          const ok = setGeoInViewer(filteredSchema);
          if (ok) {
            setStatus("Ready");
            return true;
          }
        }
      } catch {
        // ignore
      }

      if (!exportObj) {
        setStatus("Ready");
        return true;
      }

      // Ensure the viewer had time to build the RH_OUT overlay before asking it to export OBJ.
      // This avoids requesting OBJ while the overlay is still empty.
      try {
        const ready = await waitForRhOutOverlay({ timeoutMs: 30000 });
        if (ready && ready.ok === false) {
          const msg = ready?.error ? String(ready.error) : "RH_OUT overlay not ready";
          setLastError(msg);
          setStatus("Error");
          await requestSnapshot();
          return false;
        }
      } catch {
        // ignore
      }

      const res = await requestObjFromViewer({ paramNames: ["RH_OUT"] });
      if (res?.ok && res.objText) {
        try {
          setStatus("Rendering OBJ…");
          setLastError("");
          setLastObjText(res.objText);
          setObjInViewer(res.objText);
          setStatus("Ready");
          return true;
        } catch (e) {
          setLastError(String(e?.message || e));
          setStatus("Error");
          return false;
        }
      }

      const msg = res?.error ? String(res.error) : "OBJ export failed";
      setLastError(msg);
      await requestSnapshot();
      return false;
    };
  }, [renderObjToDataUrl, requestObjFromViewer, requestSnapshot, setCurvesInViewer, setPointsInViewer]);

  const exportRhOutNow = useMemo(() => {
    return async () => {
      const schema = lastSchemaRef.current;
      if (!schema) {
        setLastError("No GH result yet");
        setStatus("Error");
        return false;
      }

      extractTokenRef.current += 1;
      const token = extractTokenRef.current;

      try {
        const ready = await waitForRhOutOverlay({ timeoutMs: 30000 });
        if (ready && ready.ok === false) {
          const msg = ready?.error ? String(ready.error) : "RH_OUT overlay not ready";
          setLastError(msg);
          setStatus("Error");
          await requestSnapshot();
          return false;
        }
      } catch {
        // ignore
      }

      if (token !== extractTokenRef.current) return false;

      const res = await requestObjFromViewer({ paramNames: ["RH_OUT"] });
      if (res?.ok && res.objText) {
        try {
          setStatus("Rendering OBJ…");
          setLastError("");
          setLastObjText(res.objText);
          setObjInViewer(res.objText);
          setStatus("Ready");
          return true;
        } catch (e) {
          setLastError(String(e?.message || e));
          setStatus("Error");
          return false;
        }
      }

      const msg = res?.error ? String(res.error) : "OBJ export failed";
      setLastError(msg);
      await requestSnapshot();
      return false;
    };
  }, [requestObjFromViewer, requestSnapshot, waitForRhOutOverlay]);

  useEffect(() => {
    const onGhResult = (ev) => {
      const schema = ev?.detail?.schema;
      lastRhOutReadyRef.current = null;
      // Always store latest schema so user can export on demand.
      renderFromSchema(schema, { exportObj: autoExportRhOut });
      if (!autoExportRhOut) setLastObjText("");
    };
    window.addEventListener("grasshopper:result", onGhResult);
    return () => {
      window.removeEventListener("grasshopper:result", onGhResult);
    };
  }, [autoExportRhOut, renderFromSchema]);

  useEffect(() => {
    const onReady = (ev) => {
      const detail = ev?.detail;
      if (!detail || String(detail.paramName || "") !== "RH_OUT") return;
      lastRhOutReadyRef.current = detail;
    };
    window.addEventListener("grasshopper:overlay-ready", onReady);
    return () => window.removeEventListener("grasshopper:overlay-ready", onReady);
  }, []);

  return (
    <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 10 }}>
        <div style={{ fontSize: 12, color: "rgba(229,231,235,0.9)" }}>{status}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={() => exportRhOutNow()}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(15,118,110,0.85)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Export RH_OUT
          </button>

          <button
            type="button"
            onClick={() => setAutoExportRhOut((v) => !v)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: autoExportRhOut ? "rgba(15,118,110,0.85)" : "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Auto Export: {autoExportRhOut ? "On" : "Off"}
          </button>

          <button
            type="button"
            onClick={() => applyViewPreset("reset")}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Reset View
          </button>

          <button
            type="button"
            onClick={() => centerAndGround()}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Center & Ground
          </button>

          <button
            type="button"
            onClick={() => applyViewPreset("top")}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Top View
          </button>

          <button
            type="button"
            onClick={() => applyViewPreset("front")}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Front View
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: rotDeg.x, y: rotDeg.y - 90, z: rotDeg.z })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Rotate Left
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: -90, y: 0, z: 0 })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Lay Flat
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: -90, y: 0, z: 0 })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Z-up → Y-up
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: rotDeg.x, y: rotDeg.y + 90, z: rotDeg.z })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Rotate Right
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: 0, y: 0, z: 0 })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Reset Rotation
          </button>

          <button
            type="button"
            onClick={() => {
              if (!lastObjText) return;
              try {
                const blob = new Blob([lastObjText], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `grasshopper-${Date.now()}.obj`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch {
                // ignore
              }
            }}
            disabled={!lastObjText}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: lastObjText ? "pointer" : "not-allowed",
              opacity: lastObjText ? 1 : 0.6,
            }}
          >
            Download OBJ
          </button>

          <button
            type="button"
            onClick={() => {
              setShowWireframe((v) => {
                const next = !v;
                if (wireframeRef.current) wireframeRef.current.visible = next;
                return next;
              });
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Toggle Wireframe
          </button>

          <button
            type="button"
            onClick={() => {
              setShowAxes((v) => {
                const next = !v;
                if (axesHelperRef.current) axesHelperRef.current.visible = next;
                return next;
              });
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Toggle Axes
          </button>

          <button
            type="button"
            onClick={() => {
              setShowGrid((v) => {
                const next = !v;
                if (gridHelperRef.current) gridHelperRef.current.visible = next;
                return next;
              });
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Toggle Grid
          </button>

          <button
            type="button"
            onClick={() => {
              setShowNormals((v) => {
                const next = !v;
                syncNormalsHelper(next);
                return next;
              });
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Toggle Normals
          </button>

          <button
            type="button"
            onClick={async () => {
              if (lastObjText) {
                try {
                  setStatus("Rendering OBJ…");
                  setLastError("");
                  setObjInViewer(lastObjText);
                  setStatus("Ready");
                  return;
                } catch (e) {
                  setLastError(String(e?.message || e));
                  setStatus("Error");
                  return;
                }
              }

              try {
                await waitForRhOutOverlay({ timeoutMs: 30000 });
              } catch {
                // ignore
              }

              const res = await requestObjFromViewer({ paramNames: ["RH_OUT"] });
              if (res?.ok && res.objText) {
                try {
                  setStatus("Rendering OBJ…");
                  setLastError("");
                  setLastObjText(res.objText);
                  setObjInViewer(res.objText);
                  setStatus("Ready");
                  return;
                } catch (e) {
                  setLastError(String(e?.message || e));
                  setStatus("Error");
                  return;
                }
              }

              const msg = res?.error ? String(res.error) : "OBJ export failed";
              setLastError(msg);
              requestSnapshot();
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "rgba(0,0,0,0.22)" }}>
        {lastError ? (
          <div style={{ padding: 12, fontSize: 12, color: "rgba(248,113,113,0.95)" }}>{lastError}</div>
        ) : null}
        <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
      </div>
    </div>
  );
}

export default GrasshopperRenderPanel;
