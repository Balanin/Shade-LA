const ANALYSIS_COLOR_STOPS = [
  { t: 0.0, color: "#26124d" },
  { t: 0.25, color: "#2a6fdb" },
  { t: 0.5, color: "#18b7a6" },
  { t: 0.75, color: "#f2c94c" },
  { t: 1.0, color: "#e85d04" },
];

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const bigint = Number.parseInt(normalized, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}

function interpolateChannel(start, end, alpha) {
  return Math.round(start + (end - start) * alpha);
}

export function sampleAnalysisColor(value) {
  const clamped = clamp01(value);

  for (let index = 0; index < ANALYSIS_COLOR_STOPS.length - 1; index += 1) {
    const start = ANALYSIS_COLOR_STOPS[index];
    const end = ANALYSIS_COLOR_STOPS[index + 1];

    if (clamped >= start.t && clamped <= end.t) {
      const alpha = (clamped - start.t) / Math.max(1e-6, end.t - start.t);
      const startRgb = hexToRgb(start.color);
      const endRgb = hexToRgb(end.color);
      const rgb = {
        r: interpolateChannel(startRgb.r, endRgb.r, alpha),
        g: interpolateChannel(startRgb.g, endRgb.g, alpha),
        b: interpolateChannel(startRgb.b, endRgb.b, alpha),
      };

      return {
        ...rgb,
        css: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
      };
    }
  }

  const fallback = hexToRgb(ANALYSIS_COLOR_STOPS[ANALYSIS_COLOR_STOPS.length - 1].color);
  return {
    ...fallback,
    css: `rgb(${fallback.r}, ${fallback.g}, ${fallback.b})`,
  };
}

export function getAnalysisColorStops() {
  return ANALYSIS_COLOR_STOPS.map((stop) => ({ ...stop }));
}
