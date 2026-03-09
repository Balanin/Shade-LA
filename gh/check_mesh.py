import sys

try:
    import pyvista as pv
except Exception as e:
    raise SystemExit(
        "PyVista is not installed. Install it with: python -m pip install pyvista\n"
        f"Original error: {e}"
    )


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else r"C:\Temp\city_mesh.stl"

    mesh = pv.read(path)
    try:
        mesh = mesh.clean()
    except Exception:
        pass

    print("path:", path)
    print(mesh)
    print("bounds:", mesh.bounds)
    print("n_points:", mesh.n_points, "n_cells:", mesh.n_cells)

    try:
        print("n_open_edges:", mesh.n_open_edges)
    except Exception:
        pass

    try:
        print("is_manifold:", mesh.is_manifold)
    except Exception:
        pass

    p = pv.Plotter()
    p.add_mesh(mesh, color="lightgray", show_edges=False)
    p.add_axes()
    p.show()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
