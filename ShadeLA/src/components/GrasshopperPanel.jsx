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

  const [x, setX] = useState(10);
  const [h, setH] = useState(8);
  const [z, setZ] = useState(5);

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

  const doReset = async () => {
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
    await runSolve({ reset: true });
  };

  const runSolve = async (opts = null) => {
    setIsLoadingSolve(true);
    setStatusText("");
    setDetailsText("");
    setLastRequestText("");
    try {
      const effectiveReset = !!(opts && opts.reset === true);
      const effectiveRun = opts && typeof opts.run === "boolean" ? opts.run : true;

      const respItems = await requestCurvesFromViewer();
      if (Array.isArray(respItems) && respItems.length > 0) {
        setCurveItems(respItems);
      }

      const currentCurves = Array.isArray(respItems) && respItems.length > 0 ? respItems : curveItems;
      if (Array.isArray(respItems) && respItems.length === 0 && Array.isArray(curveItems) && curveItems.length > 0) {
        console.log("[GH] viewer returned 0 curves; using cached curves", { cached: curveItems.length });
      }

      try {
        const paramsRes = await fetch(computeParamsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x,
            h,
            z,
            edge: edgeLengthFactor,
            lineStrength: lineLengthStrength,
            lineFactor: lineLengthFactor,
            load: loadFactor,
            reset: effectiveReset,
            run: effectiveRun,
            cr: Array.isArray(currentCurves) ? currentCurves : [],
          }),
        });
        if (!paramsRes.ok) {
          let bodyText = "";
          try {
            bodyText = await paramsRes.text();
          } catch {
            // ignore
          }
          console.warn("[GH] compute params POST returned non-OK", {
            url: computeParamsUrl,
            status: paramsRes.status,
            statusText: paramsRes.statusText,
            body: bodyText,
          });
        }
      } catch (e) {
        console.warn("[GH] failed to POST /api/compute/params", {
          url: computeParamsUrl,
          error: String(e),
        });
      }

      const pointer = withCacheBust(normalizePointer(pointerUrl));

      const values = [];
      if (Array.isArray(currentCurves) && currentCurves.length) {
        values.push(buildCurveListValue("cr", currentCurves));
      }

      values.push(buildNumericValue("EdgeLengthFactor", edgeLengthFactor));
      values.push(buildNumericValue("LineLengthStrength", lineLengthStrength));
      values.push(buildNumericValue("LineLengthFactor", lineLengthFactor));
      values.push(buildNumericValue("LoadFactor", loadFactor));

      values.push(buildNumericValue("x", x));
      values.push(buildNumericValue("h", h));
      values.push(buildNumericValue("z", z));

      values.push(buildBooleanValue("run", effectiveRun));
      if (effectiveReset) values.push(buildBooleanValue("Reset", true));

      const payload = {
        pointer,
        values,
      };

      try {
        setLastRequestText(JSON.stringify(payload, null, 2));
      } catch {
        setLastRequestText(String(payload));
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
          onClick={runSolve}
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

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>x: {x}</div>
            <input type="range" min={1} max={20} step={1} value={x} onChange={(e) => setX(Number(e.target.value))} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>h: {h}</div>
            <input type="range" min={1} max={20} step={1} value={h} onChange={(e) => setH(Number(e.target.value))} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>z: {z}</div>
            <input type="range" min={1} max={20} step={1} value={z} onChange={(e) => setZ(Number(e.target.value))} />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={doReset}
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
