import L from "leaflet";

function leafletBoundsFromApp(bounds) {
  return L.latLngBounds(
    [bounds.minLat, bounds.minLon],
    [bounds.maxLat, bounds.maxLon]
  );
}

function appBoundsFromLeaflet(leafletBounds) {
  return {
    minLon: leafletBounds.getWest(),
    minLat: leafletBounds.getSouth(),
    maxLon: leafletBounds.getEast(),
    maxLat: leafletBounds.getNorth(),
  };
}

function normalizeLeafletBounds(bounds) {
  return L.latLngBounds(
    [Math.min(bounds.getSouth(), bounds.getNorth()), Math.min(bounds.getWest(), bounds.getEast())],
    [Math.max(bounds.getSouth(), bounds.getNorth()), Math.max(bounds.getWest(), bounds.getEast())]
  );
}

function buildHandleBounds(bounds) {
  return {
    nw: L.latLng(bounds.getNorth(), bounds.getWest()),
    ne: L.latLng(bounds.getNorth(), bounds.getEast()),
    se: L.latLng(bounds.getSouth(), bounds.getEast()),
    sw: L.latLng(bounds.getSouth(), bounds.getWest()),
  };
}

export function createMapPicker(container, initialBounds, logger = console.log) {
  const map = L.map(container, {
    zoomControl: true,
    preferCanvas: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const listeners = new Set();
  let rectangle = null;
  let handles = {};
  let internalUpdate = false;
  let dragState = null;
  let drawState = null;

  function emitBoundsChanged() {
    if (!rectangle || internalUpdate) {
      return;
    }

    const bounds = appBoundsFromLeaflet(rectangle.getBounds());
    logger(`Map selection updated: ${JSON.stringify(bounds)}`);
    listeners.forEach((listener) => listener(bounds));
  }

  function syncHandles() {
    if (!rectangle) {
      return;
    }

    const corners = buildHandleBounds(rectangle.getBounds());
    Object.entries(handles).forEach(([key, marker]) => {
      marker.setLatLng(corners[key]);
    });
  }

  function updateRectangle(bounds, options = {}) {
    internalUpdate = true;
    const leafletBounds = normalizeLeafletBounds(bounds);

    if (!rectangle) {
      rectangle = L.rectangle(leafletBounds, {
        color: "#0f766e",
        weight: 2,
        fillColor: "#14b8a6",
        fillOpacity: 0.14,
      }).addTo(map);

      rectangle.on("mousedown", (event) => {
        if (!rectangle) {
          return;
        }

        dragState = {
          startLatLng: event.latlng,
          startBounds: rectangle.getBounds(),
        };
        map.dragging.disable();
      });
    } else {
      rectangle.setBounds(leafletBounds);
    }

    syncHandles();
    if (options.fit) {
      map.fitBounds(leafletBounds.pad(0.6));
    }
    internalUpdate = false;
  }

  function createHandle(key) {
    const marker = L.circleMarker([0, 0], {
      radius: 6,
      color: "#0f766e",
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
      interactive: true,
    }).addTo(map);

    marker.on("mousedown", (event) => {
      drawState = {
        mode: "resize",
        handle: key,
      };
      map.dragging.disable();
      L.DomEvent.stopPropagation(event);
    });

    return marker;
  }

  handles = {
    nw: createHandle("nw"),
    ne: createHandle("ne"),
    se: createHandle("se"),
    sw: createHandle("sw"),
  };

  function updateBoundsFromHandle(handleKey, latlng) {
    const current = rectangle.getBounds();
    const corners = buildHandleBounds(current);
    corners[handleKey] = latlng;

    const nextBounds = L.latLngBounds(
      [
        Math.min(corners.nw.lat, corners.ne.lat, corners.se.lat, corners.sw.lat),
        Math.min(corners.nw.lng, corners.ne.lng, corners.se.lng, corners.sw.lng),
      ],
      [
        Math.max(corners.nw.lat, corners.ne.lat, corners.se.lat, corners.sw.lat),
        Math.max(corners.nw.lng, corners.ne.lng, corners.se.lng, corners.sw.lng),
      ]
    );

    updateRectangle(nextBounds);
    emitBoundsChanged();
  }

  map.on("mousedown", (event) => {
    if (dragState || drawState?.mode === "resize") {
      return;
    }

    if (rectangle && rectangle.getBounds().contains(event.latlng)) {
      return;
    }

    drawState = {
      mode: "draw",
      anchor: event.latlng,
    };
  });

  map.on("mousemove", (event) => {
    if (drawState?.mode === "draw") {
      updateRectangle(L.latLngBounds(drawState.anchor, event.latlng));
      return;
    }

    if (drawState?.mode === "resize" && rectangle) {
      updateBoundsFromHandle(drawState.handle, event.latlng);
      return;
    }

    if (dragState && rectangle) {
      const latDelta = event.latlng.lat - dragState.startLatLng.lat;
      const lngDelta = event.latlng.lng - dragState.startLatLng.lng;
      const startBounds = dragState.startBounds;

      updateRectangle(
        L.latLngBounds(
          [startBounds.getSouth() + latDelta, startBounds.getWest() + lngDelta],
          [startBounds.getNorth() + latDelta, startBounds.getEast() + lngDelta]
        )
      );
    }
  });

  function finalizeInteraction() {
    const shouldEmit = Boolean(drawState || dragState);
    drawState = null;
    dragState = null;
    map.dragging.enable();
    if (shouldEmit) {
      emitBoundsChanged();
    }
  }

  map.on("mouseup", finalizeInteraction);
  map.on("mouseout", () => {
    if (drawState?.mode === "resize" || dragState) {
      finalizeInteraction();
    }
  });

  updateRectangle(leafletBoundsFromApp(initialBounds), { fit: true });

  return {
    map,
    setBounds(bounds, options = {}) {
      updateRectangle(leafletBoundsFromApp(bounds), { fit: options.fit ?? false });
    },
    getBounds() {
      return rectangle ? appBoundsFromLeaflet(rectangle.getBounds()) : null;
    },
    onBoundsChanged(callback) {
      listeners.add(callback);
    },
    invalidateSize() {
      map.invalidateSize();
    },
  };
}
