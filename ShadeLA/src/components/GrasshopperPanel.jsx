import React, { useEffect, useMemo, useState } from "react";

function GrasshopperPanel() {
  const defaultPointer = useMemo(() => {
    const env = import.meta?.env?.VITE_GRASSHOPPER_POINTER_URL;
    if (env) return env;
    if (typeof window !== "undefined") {
      return `${window.location.origin}/gh/unnamed.gh`;
    }
    return "/gh/unnamed.gh";
  }, []);

  const computeParamsUrl = useMemo(() => {
    const env = import.meta?.env?.VITE_COMPUTE_PARAMS_URL;
    if (env) return String(env);
    if (typeof window !== "undefined") {
      return `${window.location.protocol}//${window.location.hostname}:3001/api/compute/params`;
    }
    return "http://localhost:3001/api/compute/params";
  }, []);

  const [pointerUrl, setPointerUrl] = useState(defaultPointer);
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

  const [curveItems, setCurveItems] = useState([]);

  const requestCurvesFromViewer = () => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      let done = false;
      const onResp = (ev) => {
        const detail = ev?.detail;
        if (!detail || detail.requestId !== requestId) return;
        done = true;
        window.removeEventListener("grasshopper:curves-response", onResp);
        const items = Array.isArray(detail.items) ? detail.items : [];
        console.log("[GH] curves received from viewer", { count: items.length });
        resolve(items);
      };

      window.addEventListener("grasshopper:curves-response", onResp);
      window.dispatchEvent(new CustomEvent("grasshopper:request-curves", { detail: { requestId } }));

      window.setTimeout(() => {
        if (done) return;
        window.removeEventListener("grasshopper:curves-response", onResp);
        console.warn("[GH] curves request timeout (viewer did not respond)");
        resolve(null);
      }, 5000);
    });
  };

  useEffect(() => {
    const onCurves = (ev) => {
      const detail = ev?.detail;
      if (!detail || detail.paramName !== "cr") return;
      const items = detail.items;
      if (!Array.isArray(items)) return;
      setCurveItems(items);
    };

    window.addEventListener("grasshopper:input-curves", onCurves);
    return () => window.removeEventListener("grasshopper:input-curves", onCurves);
  }, []);

  useEffect(() => {
    let t = 0;
    const onChanged = () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(async () => {
        t = 0;
        try {
          const items = await requestCurvesFromViewer();
          if (Array.isArray(items)) setCurveItems(items);
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

  const normalizePointer = (url) => {
    const u = String(url || "").trim();
    if (!u) return u;
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    if (typeof window !== "undefined" && u.startsWith("/")) {
      return `${window.location.origin}${u}`;
    }
    return u;
  };

  const debugPointerCacheBust = useMemo(() => {
    const env = import.meta?.env?.VITE_DEBUG_GH_POINTER_CACHEBUST;
    if (typeof env === "string") {
      const s = env.trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes";
    }
    return false;
  }, []);

  const withCacheBust = (url) => {
    try {
      const u = new URL(url);
      u.searchParams.set("__cb", String(Date.now()));
      return u.toString();
    } catch {
      const sep = String(url).includes("?") ? "&" : "?";
      return `${url}${sep}__cb=${Date.now()}`;
    }
  };

  const buildNumericValue = (paramName, value) => {
    return {
      ParamName: paramName,
      InnerTree: {
        "{ 0; }": [
          {
            type: "System.Double",
            data: String(value),
          },
        ],
      },
    };
  };

  const buildBooleanValue = (paramName, value) => {
    return {
      ParamName: paramName,
      InnerTree: {
        "{ 0; }": [
          {
            type: "System.Boolean",
            data: value ? "true" : "false",
          },
        ],
      },
    };
  };

  const defaultValues = useMemo(() => {
    return [];
  }, []);

  const buildCurveListValue = (paramName, items) => {
    return {
      ParamName: paramName,
      InnerTree: {
        "{ 0; }": (items || []).map((it) => ({ type: it.type, data: it.data })),
      },
    };
  };

  const clampActionBooleans = ({ run, reset }) => {
    const r = !!run;
    const x = !!reset;
    if (r && x) {
      // Never allow both true. Reset wins because it's a one-shot pulse.
      return { run: false, reset: true };
    }
    return { run: r, reset: x };
  };

  const resolveAction = (action) => {
    switch (String(action || "").toLowerCase()) {
      case "solve":
        return { run: true, reset: false };
      case "reset":
        return { run: false, reset: true };
      case "idle":
      default:
        return { run: false, reset: false };
    }
  };

  const buildSolvePayload = ({ action, curves, includeNumerics = true, includeCurves = true } = {}) => {
    const { run, reset } = clampActionBooleans(resolveAction(action));

    const pointerBase = normalizePointer(pointerUrl);
    const pointer = debugPointerCacheBust ? withCacheBust(pointerBase) : pointerBase;

    const values = [];

    // Geometry-dependent inputs: include on solve/idle only; on reset we intentionally omit.
    if (!reset) {
      if (includeCurves && Array.isArray(curves) && curves.length) {
        values.push(buildCurveListValue("cr", curves));
      }

      if (includeNumerics) {
        values.push(buildNumericValue("EdgeLengthFactor", edgeLengthFactor));
        values.push(buildNumericValue("LineLengthStrength", lineLengthStrength));
        values.push(buildNumericValue("LineLengthFactor", lineLengthFactor));
        values.push(buildNumericValue("LoadFactor", loadFactor));
      }
    }

    // Always send both booleans (stateless compute action model)
    values.push(buildBooleanValue("run", run));
    values.push(buildBooleanValue("reset", reset));

    return { pointer, values, action: { run, reset } };
  };

  const resetGrasshopper = async () => {
    setCurveItems([]);
    try {
      window.dispatchEvent(new CustomEvent("grasshopper:clear-result"));
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent("grasshopper:clear-curves"));
    } catch {
      // ignore
    }
    await runSolve({ action: "reset" });
  };

  const solveGrasshopper = async () => {
    await runSolve({ action: "solve" });
  };

  const idleGrasshopper = async () => {
    await runSolve({ action: "idle" });
  };

  const runSolve = async (opts = null) => {
    setIsLoadingSolve(true);
    setStatusText("");
    setDetailsText("");
    setLastRequestText("");
    try {
      const action = opts && typeof opts.action === "string" ? opts.action : "solve";
      const actionBooleans = clampActionBooleans(resolveAction(action));
      const effectiveReset = !!actionBooleans.reset;
      const effectiveRun = !!actionBooleans.run;

      let currentCurves = curveItems;
      if (!effectiveReset) {
        const respItems = await requestCurvesFromViewer();
        if (Array.isArray(respItems) && respItems.length > 0) {
          setCurveItems(respItems);
        }

        currentCurves = Array.isArray(respItems) && respItems.length > 0 ? respItems : curveItems;
        if (Array.isArray(respItems) && respItems.length === 0 && Array.isArray(curveItems) && curveItems.length > 0) {
          console.log("[GH] viewer returned 0 curves; using cached curves", { cached: curveItems.length });
        }
      }

      // Optional: keep POSTing to the params store for GH-side web receiver components.
      // Always send both booleans using the same action model.
      try {
        const body = effectiveReset
          ? { reset: true, run: false }
          : {
              edge: edgeLengthFactor,
              lineStrength: lineLengthStrength,
              lineFactor: lineLengthFactor,
              load: loadFactor,
              reset: effectiveReset,
              run: effectiveRun,
              cr: Array.isArray(currentCurves) ? currentCurves : [],
            };

        await fetch(computeParamsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        // ignore
      }

      const built = buildSolvePayload({ action, curves: currentCurves, includeNumerics: true, includeCurves: true });
      const payload = { pointer: built.pointer, values: built.values };

      try {
        setLastRequestText(JSON.stringify(payload, null, 2));
      } catch {
        setLastRequestText(String(payload));
      }

      try {
        fetch("/gh-debug-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => {
          // ignore
        });
      } catch {
        // ignore
      }

      const res = await fetch("/compute/grasshopper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let schema = null;
      try {
        schema = JSON.parse(text);
      } catch {
        schema = null;
      }

      const outCount = Array.isArray(schema?.values) ? schema.values.length : 0;
      const errCount = Array.isArray(schema?.errors) ? schema.errors.length : 0;
      const warnCount = Array.isArray(schema?.warnings) ? schema.warnings.length : 0;

      if (schema && !effectiveReset && outCount > 0) {
        try {
          window.dispatchEvent(new CustomEvent("grasshopper:result", { detail: { schema } }));
        } catch {
          // ignore
        }
      }

      if (effectiveReset) {
        try {
          window.dispatchEvent(new CustomEvent("grasshopper:clear-result"));
        } catch {
          // ignore
        }
      }

      if (res.ok) {
        console.log("[GH] solve OK", { outputs: outCount, errors: errCount, warnings: warnCount });
        const suffix = [];
        if (errCount) suffix.push(`${errCount} errors`);
        if (warnCount) suffix.push(`${warnCount} warnings`);
        const extra = suffix.length ? `; ${suffix.join(", ")}` : "";
        setStatusText(outCount > 0 ? `OK (${outCount} outputs${extra})` : `OK${extra}`);
      } else {
        const suffix = [];
        if (outCount) suffix.push(`${outCount} outputs`);
        if (errCount) suffix.push(`${errCount} errors`);
        if (warnCount) suffix.push(`${warnCount} warnings`);
        const extra = suffix.length ? ` (${suffix.join(", ")})` : "";
        setStatusText(`${res.status} ${res.statusText}${extra}`);
      }
      setDetailsText(text);
    } catch (e) {
      setStatusText("Request failed");
      setDetailsText(String(e));
    } finally {
      if (resetPulse) setResetPulse(false);
      setIsLoadingSolve(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>GH URL</div>
        <input
          value={pointerUrl}
          onChange={(e) => setPointerUrl(e.target.value)}
          style={{
            flex: "1 1 320px",
            minWidth: 220,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(0,0,0,0.25)",
            color: "#e5e7eb",
            outline: "none",
          }}
        />
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
          <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>Curves (cr):</div>
          <div style={{ color: "#e5e7eb", fontSize: 12 }}>{Array.isArray(curveItems) ? curveItems.length : 0}</div>
          <button
            type="button"
            onClick={() => setCurveItems([])}
            disabled={!Array.isArray(curveItems) || curveItems.length === 0}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: Array.isArray(curveItems) && curveItems.length ? "pointer" : "not-allowed",
              opacity: Array.isArray(curveItems) && curveItems.length ? 1 : 0.5,
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
