from __future__ import annotations

import argparse
import json
import pathlib

from analysis.mesh_from_polylines import Polyline, mesh_from_polylines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="Path to JSON file with {polylines: [[[x,y,z],...], ...]} or just a list of polylines")
    ap.add_argument("--y", type=float, default=0.0)
    ap.add_argument("--offset", type=float, default=0.0, help="Offset distance (scene units) applied to outer ring; holes offset opposite")
    ap.add_argument("--relax-iterations", type=int, default=0, help="Edge-length relaxation iterations (approx Kangaroo EdgeLengths)")
    ap.add_argument("--relax-strength", type=float, default=0.35, help="Relax step strength 0..1")
    ap.add_argument("--edge-length-factor", type=float, default=1.0, help="Target edge length multiplier")
    ap.add_argument("--out", default="", help="Optional output JSON path")
    args = ap.parse_args()

    p = pathlib.Path(args.input)
    payload = json.loads(p.read_text(encoding="utf-8"))

    polylines_raw = payload.get("polylines") if isinstance(payload, dict) else payload
    if not isinstance(polylines_raw, list):
        raise SystemExit("Input JSON must be a list of polylines or an object with key 'polylines'")

    polylines = [Polyline.from_any(pl) for pl in polylines_raw]
    mesh = mesh_from_polylines(
        polylines,
        y=args.y,
        offset_distance=float(args.offset),
        relax_iterations=int(args.relax_iterations),
        relax_strength=float(args.relax_strength),
        edge_length_factor=float(args.edge_length_factor),
    )

    out_text = json.dumps(mesh)
    if args.out:
        out_path = pathlib.Path(args.out)
        out_path.write_text(out_text, encoding="utf-8")
    else:
        print(out_text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
