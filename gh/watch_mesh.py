import argparse
import os
import time

import pyvista as pv


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("stl", nargs="?", default=r"C:\Temp\city_mesh.stl")
    p.add_argument("--poll", type=float, default=0.5)
    return p.parse_args()


def load_mesh(path: str):
    mesh = pv.read(path)
    try:
        mesh = mesh.clean()
    except Exception:
        pass
    return mesh


def main() -> int:
    args = parse_args()
    path = args.stl

    p = pv.Plotter()
    p.add_axes()

    actor = None
    last_mtime = None

    def refresh(force: bool = False):
        nonlocal actor, last_mtime

        if not os.path.exists(path):
            return

        mtime = os.path.getmtime(path)
        if (not force) and (last_mtime is not None) and (mtime == last_mtime):
            return

        mesh = load_mesh(path)

        if actor is not None:
            try:
                p.remove_actor(actor)
            except Exception:
                pass

        actor = p.add_mesh(mesh, color="lightgray", show_edges=False)
        p.reset_camera()
        p.render()
        last_mtime = mtime

        print("reloaded:", path)

    refresh(force=True)

    # Initialize the interactor in a non-blocking mode so we can call p.update().
    p.show(auto_close=False, interactive_update=True)

    # Keep one window open and poll for updates.
    while True:
        # keep the window responsive
        p.update()
        refresh(force=False)
        time.sleep(args.poll)


if __name__ == "__main__":
    raise SystemExit(main())
