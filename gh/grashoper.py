import Rhino
import json

def _unwrap_curve(obj):
    if obj is None:
        return None

    try:
        if isinstance(obj, Rhino.Geometry.Curve):
            return obj
    except:
        pass

    try:
        v = getattr(obj, "Value", None)
        if v is not None:
            try:
                if isinstance(v, Rhino.Geometry.Curve):
                    return v
            except:
                pass
    except:
        pass

    try:
        v = getattr(obj, "Curve", None)
        if v is not None:
            try:
                if isinstance(v, Rhino.Geometry.Curve):
                    return v
            except:
                pass
    except:
        pass

    return None


def _is_valid_curve(c):
    if c is None:
        return False
    try:
        return bool(c.IsValid)
    except:
        return True


def _sanitize_curve(c):
    if c is None:
        return None

    try:
        if c.IsValid:
            return c
    except:
        return c

    try:
        cc = c.DuplicateCurve()
        if cc is not None and cc.IsValid:
            return cc
    except:
        pass

    try:
        nc = c.ToNurbsCurve()
        if nc is not None and nc.IsValid:
            return nc
    except:
        pass

    try:
        pl = Rhino.Geometry.Polyline()
        if c.TryGetPolyline(pl):
            pc = Rhino.Geometry.PolylineCurve(pl)
            if pc is not None and pc.IsValid:
                return pc
    except:
        pass

    return None


def _decode_curve_item(it):
    c = _unwrap_curve(it)
    if c:
        sc = _sanitize_curve(c)
        if sc:
            return sc

    if isinstance(it, dict):
        rh_json = it.get("data", None)
        if rh_json is None:
            return None

        if isinstance(rh_json, str):
            try:
                obj = Rhino.Runtime.CommonObject.FromJSON(rh_json)
                c = _unwrap_curve(obj)
                sc = _sanitize_curve(c)
                if sc:
                    return sc
            except:
                pass

            try:
                geom_dict = json.loads(rh_json)
                obj = Rhino.Runtime.CommonObject.FromJSON(json.dumps(geom_dict))
                c = _unwrap_curve(obj)
                sc = _sanitize_curve(c)
                if sc:
                    return sc
            except:
                pass

            return None

        try:
            obj = Rhino.Runtime.CommonObject.FromJSON(json.dumps(rh_json))
            c = _unwrap_curve(obj)
            sc = _sanitize_curve(c)
            if sc:
                return sc
        except:
            pass

        return None

    if isinstance(it, str):
        try:
            obj = Rhino.Runtime.CommonObject.FromJSON(it)
            c = _unwrap_curve(obj)
            sc = _sanitize_curve(c)
            if sc:
                return sc
        except:
            pass

        try:
            geom_dict = json.loads(it)
            obj = Rhino.Runtime.CommonObject.FromJSON(json.dumps(geom_dict))
            c = _unwrap_curve(obj)
            sc = _sanitize_curve(c)
            if sc:
                return sc
        except:
            pass

        return None

    return None


def _decode_many(val):
    out_list = []
    try:
        if val is None:
            return out_list

        try:
            for it in val:
                c = _decode_curve_item(it)
                if c:
                    out_list.append(c)
            if out_list:
                return out_list
        except:
            pass

        c = _decode_curve_item(val)
        if c:
            out_list.append(c)
        return out_list
    except:
        return []


def _coerce_number(v):
    try:
        if isinstance(v, bool):
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            return float(v)
    except:
        return None
    return None


def _coerce_bool(v):
    try:
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            s = v.strip().lower()
            if s == "true":
                return True
            if s == "false":
                return False
    except:
        return None
    return None


try:
    edge
except NameError:
    edge = 0.001
try:
    lineStrength
except NameError:
    lineStrength = 16.0
try:
    lineFactor
except NameError:
    lineFactor = 1.0
try:
    load
except NameError:
    load = 5.0
try:
    reset
except NameError:
    reset = False
try:
    run
except NameError:
    run = True
try:
    cr
except NameError:
    cr = None


edge_val = edge
lineStrength_val = lineStrength
lineFactor_val = lineFactor
load_val = load
reset_val = reset
run_val = run


used_input_cr = False
used_store = False
used_default = False

curves_in = _decode_many(cr)
if curves_in:
    used_input_cr = True
    web_curves = curves_in
else:
    web_curves = []

if not web_curves:
    try:
        p0 = Rhino.Geometry.Point3d(0, 5, 0)
        p1 = Rhino.Geometry.Point3d(10, 5, 0)
        p2 = Rhino.Geometry.Point3d(5, 0, 0)
        p3 = Rhino.Geometry.Point3d(5, 10, 0)
        web_curves = [
            Rhino.Geometry.LineCurve(p0, p1),
            Rhino.Geometry.LineCurve(p2, p3),
        ]
        used_default = True
    except:
        web_curves = []
        used_default = False

b = web_curves

lenFaccor = edge_val
strength = lineStrength_val
LineLengthStrength = lineStrength_val
factor = lineFactor_val
reset = reset_val
run = run_val

out = "OK"

valid_count = 0
try:
    for cc in web_curves:
        try:
            if cc and cc.IsValid:
                valid_count += 1
        except:
            pass
except:
    valid_count = None

dbg = {
    "curves": len(web_curves) if web_curves else 0,
    "valid_curves": valid_count,
    "used_store": used_store,
    "used_input_cr": used_input_cr,
    "used_default": used_default,

    "edge_val": edge_val,
    "lineStrength_val": lineStrength_val,
    "lineFactor_val": lineFactor_val,
    "load_val": load_val,
    "reset_val": reset_val,
    "run_val": run_val,
}

dbg = json.dumps(dbg, ensure_ascii=False)

# Removed the automatic ScheduleSolution polling