"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import styles from "./dashboard.module.css";
import CesiumMap from "@/components/CesiumMap";
import compute from "compute-rhino3d";

export default function Dashboard() {
  const rhinoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const boxRef = useRef<THREE.Mesh | null>(null);
  const targetRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, 0));
  const isDraggingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const [tracts, setTracts] = useState<{ GEOID: string; NAME: string }[]>([]);
  const [selectedGeoid, setSelectedGeoid] = useState<string>("");
  const [tractFilter, setTractFilter] = useState<string>("");
  const [selectedTractData, setSelectedTractData] = useState<any | null>(null);
  const [colorBy, setColorBy] = useState<string>("Vul_Pop_Index");
  const [ghRequestJson, setGhRequestJson] = useState<string>(() => {
    const sample = {
      location: { lat: 34.05, lon: -118.25, timeZone: -8 },
      analysisPeriod: {
        start: { month: 6, day: 21, hour: 8 },
        end: { month: 6, day: 21, hour: 18 },
      },
      contextBuildings: [],
      newBuilding: {
        footprint: [
          [-118.25, 34.05],
          [-118.2495, 34.05],
          [-118.2495, 34.0505],
          [-118.25, 34.0505],
        ],
        height: 50,
      },
      options: {
        gridResolution: 5,
        analyzeGround: true,
        analyzeFacades: true,
      },
    };
    try {
      return JSON.stringify(sample, null, 2);
    } catch {
      return "";
    }
  });
  const [ghResponseText, setGhResponseText] = useState<string>("");
  const [ghIsLoading, setGhIsLoading] = useState<boolean>(false);

  // Helper: normalize a numeric index to 0..1
  const getIndexFactor = () => {
    if (!selectedTractData) return 0.5;
    const raw = selectedTractData[colorBy];
    const v = parseFloat(String(raw ?? ""));
    if (!Number.isFinite(v)) return 0.5;
    // Simple normalization: expect indices roughly in 0..100
    const clamped = Math.max(0, Math.min(100, v));
    return clamped / 100;
  };

  useEffect(() => {
    let cancelled = false;

    async function initRhino() {
      try {
        if (cancelled) return;

        const serverUrl = process.env.NEXT_PUBLIC_RHINO_COMPUTE_URL;
        if (serverUrl) {
          compute.url = serverUrl as unknown as string;
        }

        // eslint-disable-next-line no-console
        console.log("Rhino.Compute client configured with URL:", serverUrl);

        // Initialize a three.js scene inside rhinoCanvas
        const canvas = rhinoCanvasRef.current;
        if (canvas && !rendererRef.current) {
          const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
          renderer.setPixelRatio(window.devicePixelRatio || 1);

          const width = canvas.clientWidth || canvas.width || 800;
          const height = canvas.clientHeight || canvas.height || 600;
          renderer.setSize(width, height, false);

          const scene = new THREE.Scene();
          // Light background, closer to a massing-style view
          scene.background = new THREE.Color("#f4f4f4");

          const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
          camera.position.set(0, 0, 10);
          targetRef.current.set(0, 0, 0);
          camera.lookAt(targetRef.current);

          const light = new THREE.DirectionalLight(0xffffff, 0.9);
          light.position.set(10, 20, 15);
          scene.add(light);
          scene.add(new THREE.AmbientLight(0x808080));

          rendererRef.current = renderer;
          sceneRef.current = scene;
          cameraRef.current = camera;

          const animate = () => {
            if (cancelled || !rendererRef.current || !sceneRef.current || !cameraRef.current) return;
            rendererRef.current.render(sceneRef.current, cameraRef.current);
            requestAnimationFrame(animate);
          };
          animate();

          const handleResize = () => {
            if (!rendererRef.current || !cameraRef.current || !rhinoCanvasRef.current) return;
            const w = rhinoCanvasRef.current.clientWidth || rhinoCanvasRef.current.width;
            const h = rhinoCanvasRef.current.clientHeight || rhinoCanvasRef.current.height;
            rendererRef.current.setSize(w, h, false);
            cameraRef.current.aspect = w / h;
            cameraRef.current.updateProjectionMatrix();
          };
          window.addEventListener("resize", handleResize);

          const handleWheel = (ev: WheelEvent) => {
            if (!cameraRef.current) return;
            ev.preventDefault();
            const camera = cameraRef.current;
            const target = targetRef.current;
            const dir = new THREE.Vector3().subVectors(camera.position, target);
            const factor = ev.deltaY > 0 ? 1.1 : 0.9; // out / in
            dir.multiplyScalar(factor);
            camera.position.copy(new THREE.Vector3().addVectors(target, dir));
            camera.lookAt(target);
          };

          canvas.addEventListener("wheel", handleWheel, { passive: false });

          const handleMouseDown = (ev: MouseEvent) => {
            isDraggingRef.current = true;
            lastPosRef.current = { x: ev.clientX, y: ev.clientY };
          };

          const handleMouseUp = () => {
            isDraggingRef.current = false;
            lastPosRef.current = null;
          };

          const handleMouseMove = (ev: MouseEvent) => {
            if (!isDraggingRef.current || !cameraRef.current || !lastPosRef.current) return;
            const canvasEl = rhinoCanvasRef.current;
            if (!canvasEl) return;
            const { clientWidth, clientHeight } = canvasEl;
            const dx = (ev.clientX - lastPosRef.current.x) / clientWidth;
            const dy = (ev.clientY - lastPosRef.current.y) / clientHeight;
            lastPosRef.current = { x: ev.clientX, y: ev.clientY };

            const camera = cameraRef.current;
            const target = targetRef.current;
            const offset = new THREE.Vector3().subVectors(camera.position, target);
            const spherical = new THREE.Spherical().setFromVector3(offset);

            const ROTATE_SPEED = 2.5;
            spherical.theta -= dx * ROTATE_SPEED;
            spherical.phi -= dy * ROTATE_SPEED;
            const EPS = 0.01;
            spherical.phi = Math.max(EPS, Math.min(Math.PI - EPS, spherical.phi));

            offset.setFromSpherical(spherical);
            camera.position.copy(new THREE.Vector3().addVectors(target, offset));
            camera.lookAt(target);
          };

          canvas.addEventListener("mousedown", handleMouseDown);
          window.addEventListener("mouseup", handleMouseUp);
          canvas.addEventListener("mouseleave", handleMouseUp);
          canvas.addEventListener("mousemove", handleMouseMove);

          // You can add AxesHelper if needed, but it is currently disabled
          // so it does not interfere with perceiving the city.

          // NOTE: for simplicity we currently do not remove handlers on unmount,
          // because this is a single-page screen. If needed, handlers can be
          // stored in useRef and removed in the effect cleanup.
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to initialize compute-rhino3d", err);
      }
    }

    initRhino();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load tracts list for the right panel
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/tracts");
        if (!res.ok) return;
        const items = await res.json();
        if (!cancelled) {
          setTracts(items);
          if (items.length && !selectedGeoid) {
            setSelectedGeoid(items[0].GEOID);
          }
        }
      } catch {
        // ignore for now
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load data for the selected tract
  useEffect(() => {
    if (!selectedGeoid) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/tracts?geoid=${encodeURIComponent(selectedGeoid)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setSelectedTractData(data);
      } catch {
        // ignore for now
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [selectedGeoid]);

  async function handleSendToGrasshopper() {
    if (!ghRequestJson.trim()) return;
    try {
      setGhIsLoading(true);
      setGhResponseText("");
      let payload: any;
      try {
        payload = JSON.parse(ghRequestJson);
      } catch (e: any) {
        setGhResponseText("Invalid JSON in request body: " + String(e?.message || e));
        setGhIsLoading(false);
        return;
      }
      const res = await fetch("/api/analyze-city", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      setGhResponseText(text);
    } catch (err: any) {
      setGhResponseText("Request failed: " + String(err?.message || err));
    } finally {
      setGhIsLoading(false);
    }
  }

  return (
    <div className={styles.appGrid}>
      {/* Top left: Rhino 3D viewer */}
      <section className={`${styles.panel} ${styles.rhinoPanel}`}>
        <div className={styles.panelHeader}>Rhino 3D View</div>
        <canvas
          id="rhino-canvas"
          ref={rhinoCanvasRef}
          className={styles.rhinoCanvas}
        />
      </section>

      {/* Top right: Grasshopper / UI */}
      <section className={`${styles.panel} ${styles.ghPanel}`}>
        <div className={styles.panelHeader}>Analytics &amp; Coloring</div>
        <div id="gh-ui" className={styles.ghUi}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <label>
              <span>Search tract: </span>
              <input
                type="text"
                value={tractFilter}
                onChange={(e) => setTractFilter(e.target.value)}
                placeholder="Type tract name or GEOID..."
                style={{ width: "100%" }}
              />
            </label>

            <label>
              <span>Tract (GEOID): </span>
              <select
                value={selectedGeoid}
                onChange={(e) => setSelectedGeoid(e.target.value)}
                style={{ width: "100%" }}
              >
                {tracts
                  .filter((t) => {
                    if (!tractFilter.trim()) return true;
                    const q = tractFilter.toLowerCase();
                    return (
                      (t.NAME || "").toLowerCase().includes(q) ||
                      (t.GEOID || "").toLowerCase().includes(q)
                    );
                  })
                  .map((t) => (
                    <option key={t.GEOID} value={t.GEOID}>
                      {t.NAME || t.GEOID}
                    </option>
                  ))}
              </select>
            </label>

            <label>
              <span>Color by index: </span>
              <select
                value={colorBy}
                onChange={(e) => setColorBy(e.target.value)}
                style={{ width: "100%" }}
              >
                <option value="Vul_Pop_Index">Vul_Pop_Index</option>
                <option value="Trees_Index">Trees_Index</option>
                <option value="Heat_Buddy_Index">Heat_Buddy_Index</option>
                <option value="Cooling_Center_Index">Cooling_Center_Index</option>
                <option value="Pres_Open_Space_Index">Pres_Open_Space_Index</option>
                <option value="Reduce_Imp_Surf_Index">Reduce_Imp_Surf_Index</option>
                <option value="Restore_Builtup_Index">Restore_Builtup_Index</option>
                <option value="intervention_score">intervention_score</option>
              </select>
            </label>

            {selectedTractData && (
              <div style={{ maxHeight: "100%", overflowY: "auto", fontSize: "0.8rem" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    <tr>
                      <td>Mean_Annual_Est_PM2_5</td>
                      <td>{selectedTractData.Mean_Annual_Est_PM2_5}</td>
                    </tr>
                    <tr>
                      <td>CASTHMA_CrudePrev</td>
                      <td>{selectedTractData.CASTHMA_CrudePrev}</td>
                    </tr>
                    <tr>
                      <td>High_Summer_Mean_LST_F</td>
                      <td>{selectedTractData.High_Summer_Mean_LST_F}</td>
                    </tr>
                    <tr>
                      <td>PCT_TreeCanopy</td>
                      <td>{selectedTractData.PCT_TreeCanopy}</td>
                    </tr>
                    <tr>
                      <td>PCT_LackingCanopy</td>
                      <td>{selectedTractData.PCT_LackingCanopy}</td>
                    </tr>
                    <tr>
                      <td>PCT_ImperviousSurfaces</td>
                      <td>{selectedTractData.PCT_ImperviousSurfaces}</td>
                    </tr>
                    <tr>
                      <td>Area_SqKm</td>
                      <td>{selectedTractData.Area_SqKm}</td>
                    </tr>
                    <tr>
                      <td>Vul_Pop_Index</td>
                      <td>{selectedTractData.Vul_Pop_Index}</td>
                    </tr>
                    <tr>
                      <td>Trees_Index</td>
                      <td>{selectedTractData.Trees_Index}</td>
                    </tr>
                    <tr>
                      <td>Heat_Buddy_Index</td>
                      <td>{selectedTractData.Heat_Buddy_Index}</td>
                    </tr>
                    <tr>
                      <td>Cooling_Center_Index</td>
                      <td>{selectedTractData.Cooling_Center_Index}</td>
                    </tr>
                    <tr>
                      <td>Pres_Open_Space_Index</td>
                      <td>{selectedTractData.Pres_Open_Space_Index}</td>
                    </tr>
                    <tr>
                      <td>Reduce_Imp_Surf_Index</td>
                      <td>{selectedTractData.Reduce_Imp_Surf_Index}</td>
                    </tr>
                    <tr>
                      <td>Restore_Builtup_Index</td>
                      <td>{selectedTractData.Restore_Builtup_Index}</td>
                    </tr>
                    <tr>
                      <td>intervention_score</td>
                      <td>{selectedTractData.intervention_score}</td>
                    </tr>
                    <tr>
                      <td>WF_HousingDensity_MEAN</td>
                      <td>{selectedTractData.WF_HousingDensity_MEAN}</td>
                    </tr>
                    <tr>
                      <td>WF_Exp_Type_MEAN</td>
                      <td>{selectedTractData.WF_Exp_Type_MEAN}</td>
                    </tr>
                    <tr>
                      <td>WF_RiskToHome_Mean</td>
                      <td>{selectedTractData.WF_RiskToHome_Mean}</td>
                    </tr>
                    <tr>
                      <td>WF_HazardPotential_Mean</td>
                      <td>{selectedTractData.WF_HazardPotential_Mean}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            <hr />
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.8rem" }}>Grasshopper / Rhino.Compute</div>
              <div style={{ fontSize: "0.75rem" }}>
                Request body for <code>/api/analyze-city</code> (editable JSON):
              </div>
              <textarea
                value={ghRequestJson}
                onChange={(e) => setGhRequestJson(e.target.value)}
                style={{ width: "100%", minHeight: 120, fontSize: "0.75rem", fontFamily: "monospace" }}
              />
              <button
                onClick={handleSendToGrasshopper}
                disabled={ghIsLoading}
                style={{
                  padding: "6px 10px",
                  borderRadius: 4,
                  border: "1px solid #d1d5db",
                  background: "#111827",
                  color: "#ffffff",
                  cursor: ghIsLoading ? "wait" : "pointer",
                  fontSize: "0.75rem",
                }}
              >
                {ghIsLoading ? "Sending to Grasshopper..." : "Send to Grasshopper"}
              </button>
              {ghResponseText && (
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 200,
                    overflowY: "auto",
                    fontSize: "0.75rem",
                    background: "#111827",
                    color: "#e5e7eb",
                    padding: 8,
                    borderRadius: 4,
                  }}
                >
                  {ghResponseText}
                </pre>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Bottom: Kadmapper / Cesium map */}
      <section className={`${styles.panel} ${styles.mapPanel}`}>
        <div className={styles.panelHeader}>Kadmapper Map</div>
        <div id="map-container" className={styles.mapContainer}>
          <CesiumMap />
        </div>
      </section>
    </div>
  );
}
