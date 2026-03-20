import json

"""
GhPython Output-Contract Template

Inputs (suggested):
- run: bool
- reset: bool
- mesh_in: Rhino.Geometry.Mesh (or whatever your solver produces)
- stableCount / maxDelta / hasFrozen: optional diagnostics from your solver

Outputs (connect these to GH output parameters with EXACT nicknames):
- RH_OUT    (Mesh)
- RH_READY  (Boolean)
- RH_STATUS (String)
- RH_META   (String, JSON)

IMPORTANT:
- Output parameter names in Grasshopper must be unique.
- RH_META must always be valid JSON.
"""


def _safe_bool(v):
    try:
        return bool(v)
    except:
        return False


def _mesh_counts(m):
    """Return (vertexCount, faceCount) if possible."""
    try:
        if m is None:
            return (0, 0)
        vc = m.Vertices.Count
        fc = m.Faces.Count
        return (int(vc), int(fc))
    except:
        return (0, 0)


def _is_mesh_valid(m):
    try:
        if m is None:
            return False
        # In RhinoCommon, Mesh.IsValid is a property.
        if hasattr(m, "IsValid"):
            return bool(m.IsValid)
        # Fallback: basic counts
        vc, fc = _mesh_counts(m)
        return vc > 0 and fc > 0
    except:
        return False


# ---- Contract outputs ----

RH_OUT = None
RH_READY = False
RH_STATUS = "idle"

meta = {
    "stableCount": None,
    "maxDelta": None,
    "hasFrozen": None,
    "vertexCount": 0,
    "faceCount": 0,
    "run": _safe_bool(globals().get("run", False)),
    "reset": _safe_bool(globals().get("reset", False)),
    "error": None,
    "message": None,
}

# Optional diagnostics (only if your solver provides them)
for k in ("stableCount", "maxDelta", "hasFrozen"):
    if k in globals():
        try:
            meta[k] = globals().get(k)
        except:
            pass

try:
    is_reset = meta["reset"]
    is_run = meta["run"]

    if is_reset:
        RH_READY = False
        RH_STATUS = "reset"
        RH_OUT = None

    else:
        # Your solver should drive the contract with either:
        # - a final mesh in mesh_in (ready)
        # - or no mesh yet (running/waiting)
        mesh_in = globals().get("mesh_in", None)

        if _is_mesh_valid(mesh_in):
            vc, fc = _mesh_counts(mesh_in)
            meta["vertexCount"] = vc
            meta["faceCount"] = fc

            RH_OUT = mesh_in
            RH_READY = True
            RH_STATUS = "ready"

        else:
            RH_OUT = None
            RH_READY = False
            RH_STATUS = "running" if is_run else "idle"

except Exception as e:
    RH_OUT = None
    RH_READY = False
    RH_STATUS = "error"
    meta["error"] = str(e)
    meta["message"] = "Exception in contract wrapper"

# Always valid JSON
try:
    RH_META = json.dumps(meta)
except Exception as e:
    RH_META = json.dumps({"error": "meta_json_failed", "message": str(e)})
