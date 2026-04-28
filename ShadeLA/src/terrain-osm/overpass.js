const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export function splitBounds(bounds) {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const midLon = (bounds.minLon + bounds.maxLon) / 2;

  return [
    { ...bounds, maxLat: midLat, maxLon: midLon },
    { ...bounds, maxLat: midLat, minLon: midLon },
    { ...bounds, minLat: midLat, maxLon: midLon },
    { ...bounds, minLat: midLat, minLon: midLon },
  ];
}

export async function fetchOverpassJson(query, logger = console.log, options = {}) {
  const {
    endpoints = DEFAULT_OVERPASS_ENDPOINTS,
    retriesPerEndpoint = 2,
    baseDelayMs = 800,
    maxDelayMs = 7000,
    timeoutMs = 45000,
  } = options;

  let lastError;

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt <= retriesPerEndpoint; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        logger(`Overpass request: ${endpoint}`);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: query,
          signal: controller.signal,
        });

        if (!response.ok) {
          const details = await response.text().catch(() => "");
          const err = new Error(`Overpass request failed with ${response.status}. ${details}`.trim());
          err.status = response.status;
          throw err;
        }

        const json = await response.json();
        return json;
      } catch (e) {
        lastError = e;

        const status = e?.status;
        const isAbort = e?.name === "AbortError";

        const retryable = isAbort || (typeof status === "number" && isRetryableStatus(status));
        if (!retryable || attempt >= retriesPerEndpoint) {
          break;
        }

        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        await sleep(delay);
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  throw lastError || new Error("Overpass request failed");
}

export function mergeFeatures(featureLists) {
  const map = new Map();

  for (const list of featureLists) {
    for (const feature of list || []) {
      const key =
        feature?.id ??
        feature?.properties?.["@id"] ??
        feature?.properties?.id ??
        feature?.properties?.osm_id ??
        JSON.stringify(feature?.geometry ?? null);

      if (!map.has(key)) {
        map.set(key, feature);
      }
    }
  }

  return Array.from(map.values());
}
