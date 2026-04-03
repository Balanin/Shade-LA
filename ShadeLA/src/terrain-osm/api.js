const API_BASE_URL = "https://portal.opentopography.org/API/usgsdem";

export const DATASETS = [
  { id: "USGS1m", label: "USGS 1m" },
  { id: "USGS10m", label: "USGS 1/3 arc-second fallback" },
];

export function validateBounds(bounds) {
  const values = Object.values(bounds);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Bounding box values must be valid numbers.");
  }

  if (bounds.minLon < -180 || bounds.maxLon > 180) {
    throw new Error("Longitude values must be between -180 and 180.");
  }

  if (bounds.minLat < -90 || bounds.maxLat > 90) {
    throw new Error("Latitude values must be between -90 and 90.");
  }

  if (bounds.minLon >= bounds.maxLon || bounds.minLat >= bounds.maxLat) {
    throw new Error("Bounding box minimums must be smaller than maximums.");
  }
}

function buildRequestUrl(bounds, datasetName, apiKey) {
  const params = new URLSearchParams({
    datasetName,
    south: String(bounds.minLat),
    north: String(bounds.maxLat),
    west: String(bounds.minLon),
    east: String(bounds.maxLon),
    outputFormat: "GTiff",
    API_Key: apiKey,
  });

  return `${API_BASE_URL}?${params.toString()}`;
}

function classifyApiFailure(response, responseText, dataset) {
  const text = (responseText || "").toLowerCase();
  const commonMessage = responseText?.trim() || `${response.status} ${response.statusText}`.trim();

  if (
    response.status === 401 ||
    response.status === 403 ||
    text.includes("academic") ||
    text.includes("not authorized") ||
    text.includes("unauthorized")
  ) {
    return {
      code: "unauthorized",
      message: `${dataset.label} access was rejected. OpenTopography currently restricts USGS 1 m access for some users.`,
      details: commonMessage,
      fallbackEligible: dataset.id === "USGS1m",
    };
  }

  if (text.includes("no data") || text.includes("no coverage") || text.includes("outside") || text.includes("empty")) {
    return {
      code: "no-coverage",
      message: `${dataset.label} has no DEM coverage for this area of interest.`,
      details: commonMessage,
      fallbackEligible: dataset.id === "USGS1m",
    };
  }

  if (text.includes("too large") || text.includes("maximum area") || text.includes("exceed") || text.includes("limit")) {
    return {
      code: "request-too-large",
      message: `${dataset.label} request area is too large for the service.`,
      details: commonMessage,
      fallbackEligible: dataset.id === "USGS1m",
    };
  }

  if (response.status >= 500) {
    return {
      code: "server-error",
      message: `${dataset.label} request failed because the upstream service returned an error.`,
      details: commonMessage,
      fallbackEligible: dataset.id === "USGS1m",
    };
  }

  return {
    code: "request-failed",
    message: `${dataset.label} request failed.`,
    details: commonMessage,
    fallbackEligible: dataset.id === "USGS1m",
  };
}

async function fetchDataset(bounds, apiKey, dataset, logger) {
  const url = buildRequestUrl(bounds, dataset.id, apiKey);
  logger(`Requesting ${dataset.label}: ${url.replace(apiKey, "***")}`);

  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    throw {
      code: "network-error",
      message: "Network or CORS failure while contacting OpenTopography.",
      details: error instanceof Error ? error.message : String(error),
      fallbackEligible: dataset.id === "USGS1m",
    };
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw classifyApiFailure(response, responseText, dataset);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text") || contentType.includes("json") || contentType.includes("xml")) {
    const responseText = await response.text();
    const synthesizedError = classifyApiFailure(response, responseText, dataset);
    throw {
      ...synthesizedError,
      message: `${dataset.label} returned a non-GeoTIFF payload.`,
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  logger(`Received ${dataset.label} payload: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

  return { arrayBuffer, dataset, url };
}

export async function fetchDemWithFallback(bounds, apiKey, logger = console.log) {
  if (!apiKey) {
    throw new Error("Missing API key. Add VITE_OPENTOPO_API_KEY to .env.local.");
  }

  validateBounds(bounds);

  let lastError = null;

  for (const dataset of DATASETS) {
    try {
      logger(`Trying dataset: ${dataset.label}`);
      const result = await fetchDataset(bounds, apiKey, dataset, logger);
      return {
        ...result,
        fallbackReason: lastError?.message ?? null,
      };
    } catch (error) {
      lastError = error;
      logger(`${dataset.label} failed: ${error.message}${error.details ? ` (${error.details})` : ""}`);

      if (!error.fallbackEligible) {
        break;
      }
    }
  }

  const failure = lastError instanceof Error ? { message: lastError.message } : lastError;
  throw new Error(`${failure?.message || "DEM request failed."}${failure?.details ? ` Details: ${failure.details}` : ""}`);
}
