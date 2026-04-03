const EARTH_RADIUS_METERS = 6378137;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

export function boundsToKey(bounds, precision = 6) {
  return [
    bounds.minLon.toFixed(precision),
    bounds.minLat.toFixed(precision),
    bounds.maxLon.toFixed(precision),
    bounds.maxLat.toFixed(precision),
  ].join(",");
}

export function formatBounds(bounds, precision = 6) {
  return `W ${bounds.minLon.toFixed(precision)}, S ${bounds.minLat.toFixed(precision)}, E ${bounds.maxLon.toFixed(precision)}, N ${bounds.maxLat.toFixed(precision)}`;
}

export function terrainSizeFromBounds(bounds) {
  const centerLatRadians = degreesToRadians((bounds.minLat + bounds.maxLat) / 2);
  const lonSpanRadians = degreesToRadians(Math.abs(bounds.maxLon - bounds.minLon));
  const latSpanRadians = degreesToRadians(Math.abs(bounds.maxLat - bounds.minLat));

  return {
    width: Math.max(1, EARTH_RADIUS_METERS * Math.cos(centerLatRadians) * lonSpanRadians),
    depth: Math.max(1, EARTH_RADIUS_METERS * latSpanRadians),
  };
}

export function createGeoReference(bounds, rasterWidth, rasterHeight) {
  const terrainSize = terrainSizeFromBounds(bounds);

  return {
    bounds: { ...bounds },
    terrainWidth: terrainSize.width,
    terrainDepth: terrainSize.depth,
    rasterWidth,
    rasterHeight,
    centerLon: (bounds.minLon + bounds.maxLon) / 2,
    centerLat: (bounds.minLat + bounds.maxLat) / 2,
  };
}

export function lonLatToLocalMeters(lon, lat, geoReference) {
  const { bounds, terrainWidth, terrainDepth } = geoReference;
  const lonNorm = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
  const latNorm = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);

  return {
    x: lonNorm * terrainWidth - terrainWidth / 2,
    z: terrainDepth / 2 - latNorm * terrainDepth,
  };
}

export function localMetersToLonLat(x, z, geoReference) {
  const { bounds, terrainWidth, terrainDepth } = geoReference;
  const lonNorm = (x + terrainWidth / 2) / terrainWidth;
  const latNorm = (terrainDepth / 2 - z) / terrainDepth;

  return {
    lon: bounds.minLon + lonNorm * (bounds.maxLon - bounds.minLon),
    lat: bounds.minLat + latNorm * (bounds.maxLat - bounds.minLat),
  };
}

export function clampLocalPointToFootprint(point, geoReference) {
  return {
    x: clamp(point.x, -geoReference.terrainWidth / 2, geoReference.terrainWidth / 2),
    z: clamp(point.z, -geoReference.terrainDepth / 2, geoReference.terrainDepth / 2),
  };
}

export function localRectangleToBounds(startPoint, endPoint, geoReference) {
  const xMin = Math.min(startPoint.x, endPoint.x);
  const xMax = Math.max(startPoint.x, endPoint.x);
  const zMin = Math.min(startPoint.z, endPoint.z);
  const zMax = Math.max(startPoint.z, endPoint.z);

  const northWest = localMetersToLonLat(xMin, zMin, geoReference);
  const southEast = localMetersToLonLat(xMax, zMax, geoReference);

  return {
    minLon: Math.min(northWest.lon, southEast.lon),
    minLat: Math.min(northWest.lat, southEast.lat),
    maxLon: Math.max(northWest.lon, southEast.lon),
    maxLat: Math.max(northWest.lat, southEast.lat),
  };
}

export function lonLatToRasterPosition(lon, lat, geoReference) {
  const column =
    ((lon - geoReference.bounds.minLon) / (geoReference.bounds.maxLon - geoReference.bounds.minLon)) *
    (geoReference.rasterWidth - 1);
  const row =
    ((geoReference.bounds.maxLat - lat) / (geoReference.bounds.maxLat - geoReference.bounds.minLat)) *
    (geoReference.rasterHeight - 1);

  return {
    column: clamp(column, 0, geoReference.rasterWidth - 1),
    row: clamp(row, 0, geoReference.rasterHeight - 1),
  };
}

export function sampleRasterElevation(parsedTerrain, geoReference, lon, lat) {
  const { raster, width, height } = parsedTerrain;
  const position = lonLatToRasterPosition(lon, lat, geoReference);
  const x0 = Math.floor(position.column);
  const x1 = Math.min(width - 1, Math.ceil(position.column));
  const y0 = Math.floor(position.row);
  const y1 = Math.min(height - 1, Math.ceil(position.row));
  const tx = position.column - x0;
  const ty = position.row - y0;

  const index00 = y0 * width + x0;
  const index10 = y0 * width + x1;
  const index01 = y1 * width + x0;
  const index11 = y1 * width + x1;

  const top = raster[index00] * (1 - tx) + raster[index10] * tx;
  const bottom = raster[index01] * (1 - tx) + raster[index11] * tx;

  return top * (1 - ty) + bottom * ty;
}
