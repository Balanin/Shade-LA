import React, { useEffect, useMemo, useRef, useState } from "react";
import { runMeshFromPolylines } from "../terrain-osm/analysis-api";

function GrasshopperPanel() {
  const [statusText, setStatusText] = useState("");
  const [detailsText, setDetailsText] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [lastRequestText, setLastRequestText] = useState("");

  const [edgeLengthFactor, setEdgeLengthFactor] = useState(0.01);
  const [lineLengthStrength, setLineLengthStrength] = useState(8);
  const [lineLengthFactor, setLineLengthFactor] = useState(0.5);
  const [loadFactor, setLoadFactor] = useState(1.62134);
  const [resetPulse, setResetPulse] = useState(false);

  const [isLoadingSolve, setIsLoadingSolve] = useState(false);

  const solveSeqRef = useRef(0);
  const solveAbortRef = useRef(null);

  const [polylineCount, setPolylineCount] = useState(0);

  const requestPolylinesFromViewer = () => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      let done = false;
      const onResp = (ev) => {
        const detail = ev?.detail;
        if (!detail || detail.requestId !== requestId) return;
        done = true;
        window.removeEventListener("mesh:polylines-response", onResp);
        const polylines = Array.isArray(detail.polylines) ? detail.polylines : [];
        resolve(polylines);
      };

      window.addEventListener("mesh:polylines-response", onResp);
      window.dispatchEvent(new CustomEvent("mesh:request-polylines", { detail: { requestId } }));

      window.setTimeout(() => {
        if (done) return;
        window.removeEventListener("mesh:polylines-response", onResp);
        resolve(null);
      }, 5000);
    });
  };

  useEffect(() => {
    let t = 0;
    const onChanged = () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(async () => {
        t = 0;
        try {
          const polylines = await requestPolylinesFromViewer();
          if (Array.isArray(polylines)) setPolylineCount(polylines.length);
        } catch {
          // ignore
        }
      }, 150);
    };

    window.addEventListener("grasshopper:drawings-changed", onChanged);
    return () => {
      window.removeEventListener("grasshopper:drawings-changed", onChanged);
      if (t) window.clearTimeout(t);
    };
  }, []);

  const clearCurvesInViewer = () => {
    try {
      window.dispatchEvent(new CustomEvent("grasshopper:clear-curves"));
    } catch {
      // ignore
    }
  };

  const clearMeshInViewer = () => {
    try {
      window.dispatchEvent(new CustomEvent("mesh:clear"));
    } catch {
      // ignore
    }
  };

  const resetGrasshopper = async () => {
    setPolylineCount(0);
    clearMeshInViewer();
    clearCurvesInViewer();
    setStatusText("Ready");
    setDetailsText("");
    setLastRequestText("");
    setResetPulse(true);
    window.setTimeout(() => setResetPulse(false), 0);
  };

  const solveGrasshopper = async () => {
    solveSeqRef.current += 1;
    const seq = solveSeqRef.current;

    try {
      solveAbortRef.current?.abort?.();
    } catch {
      // ignore
    }

    const controller = new AbortController();
    solveAbortRef.current = controller;

    setIsLoadingSolve(true);
    setStatusText("Running...");
    setDetailsText("");
    setLastRequestText("");

    try {
      const polylines = await requestPolylinesFromViewer();
      if (seq !== solveSeqRef.current) return;

      if (!Array.isArray(polylines) || polylines.length < 1) {
        setStatusText("No curves");
        return;
      }

      setPolylineCount(polylines.length);

      const options = {
        offset: 0,
        reconstruct_mode: "auto",
        hull_mode: "concave",
        concave_k: 12,
        segment_join_tolerance: 0.25,

        refine_steps: 2,

        canopy_height: Math.max(0, edgeLengthFactor * 50),
        load: Math.max(0, loadFactor / 3),
        damping: Math.max(0.0, Math.min(0.999, 1 - lineLengthStrength / 100)),
        relax_iterations: Math.max(0, Math.floor(loadFactor * 15)),
        relax_strength: Math.max(0, lineLengthStrength / 10),
        edge_length_factor: Math.max(0.01, lineLengthFactor),
      };

      const request = { polylines, options };
      try {
        setLastRequestText(JSON.stringify(request, null, 2));
      } catch {
        setLastRequestText(String(request));
      }

      const response = await runMeshFromPolylines(request);
      if (seq !== solveSeqRef.current) return;

      try {
        setDetailsText(JSON.stringify(response, null, 2));
      } catch {
        setDetailsText(String(response));
      }

      const mesh = response?.mesh;
      if (!mesh) {
        throw new Error("Backend returned no mesh");
      }

      try {
        window.dispatchEvent(new CustomEvent("mesh:apply", { detail: { mesh } }));
      } catch {
        // ignore
      }

      setStatusText("Ready");
    } catch (e) {
      const name = String(e?.name || "");
      if (name === "AbortError") return;
      setStatusText("Request failed");
      setDetailsText(String(e?.message || e));
    } finally {
      if (seq !== solveSeqRef.current) return;
      setIsLoadingSolve(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>Backend</div>
        <button
          type="button"
          onClick={solveGrasshopper}
          disabled={isLoadingSolve}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(15,118,110,0.85)",
            color: "#e5e7eb",
            cursor: isLoadingSolve ? "wait" : "pointer",
          }}
        >
          {isLoadingSolve ? "Running..." : "Run"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>EdgeLengthFactor: {edgeLengthFactor}</div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={edgeLengthFactor}
              onChange={(e) => setEdgeLengthFactor(Number(e.target.value))}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>LineLengthStrength: {lineLengthStrength}</div>
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={lineLengthStrength}
              onChange={(e) => setLineLengthStrength(Number(e.target.value))}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>LineLengthFactor: {lineLengthFactor}</div>
            <input
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={lineLengthFactor}
              onChange={(e) => setLineLengthFactor(Number(e.target.value))}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>LoadFactor: {loadFactor}</div>
            <input
              type="range"
              min={0}
              max={40.04001}
              step={0.00001}
              value={loadFactor}
              onChange={(e) => setLoadFactor(Number(e.target.value))}
            />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={resetGrasshopper}
            disabled={isLoadingSolve}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: isLoadingSolve ? "wait" : "pointer",
              opacity: isLoadingSolve ? 0.7 : 1,
            }}
          >
            Reset
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>Curves:</div>
          <div style={{ color: "#e5e7eb", fontSize: 12 }}>{polylineCount}</div>
          <button
            type="button"
            onClick={() => {
              clearCurvesInViewer();
              setPolylineCount(0);
            }}
            disabled={polylineCount === 0}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: polylineCount ? "pointer" : "not-allowed",
              opacity: polylineCount ? 1 : 0.5,
            }}
          >
            Clear curves
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>Status:</div>
          <div style={{ color: "#e5e7eb", fontSize: 12 }}>{statusText}</div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            disabled={!detailsText}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: detailsText ? "pointer" : "not-allowed",
              opacity: detailsText ? 1 : 0.5,
            }}
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>

        {showDetails && (
          <pre
            style={{
              margin: 0,
              padding: 10,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(0,0,0,0.25)",
              color: "#e5e7eb",
              overflow: "auto",
              minHeight: 0,
              flex: 1,
              fontSize: 12,
            }}
          >
            {lastRequestText ? `REQUEST\n${lastRequestText}\n\n` : ""}
            {detailsText ? `RESPONSE\n${detailsText}` : ""}
          </pre>
        )}
      </div>
    </div>
  );
}

export default GrasshopperPanel;
