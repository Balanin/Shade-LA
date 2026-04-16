ShadeLA – Run & Deploy Notes

============================================================
1) What is in this repo
============================================================

This repository contains multiple subsystems:

A) UI (Vite + React)
- Location: ShadeLA/
- Port (dev): http://localhost:5173

B) Solar Analysis API (FastAPI / Python)
- Location: ShadeLA/server/
- Port (dev): http://127.0.0.1:8001 (see npm script dev:api)

C) CAD / 3D App (Next.js)
- Location: ShadeLA/cad-3d/
- Port (dev): http://localhost:3001

D) Rhino Compute (dotnet)
- Location: ShadeLA/compute.rhino3d/
- Port (dev): http://localhost:6500

============================================================
2) Prerequisites
============================================================

- Node.js (for UI + cad-3d)
- Python 3.x (for FastAPI server)
- .NET SDK (for Rhino Compute)

============================================================
3) Single shared environment file
============================================================

Use ONE shared env file:

  ShadeLA/.env

Notes:
- This file is usually gitignored (do NOT commit secrets).
- Vite reads env automatically from ShadeLA/.env
- Python API loads ShadeLA/.env via python-dotenv in server/app.py
- cad-3d loads ShadeLA/.env via dotenv in cad-3d/next.config.ts and next.config.mjs

Recommended contents (fill in secrets where needed):

# UI (Vite)
VITE_OPENTOPO_API_KEY=
VITE_ANALYSIS_API_BASE_URL=http://127.0.0.1:8001
VITE_CADMAPPER_URL=http://localhost:3001
VITE_COMPUTE_KEY=shadela-local

# Solar analysis backend (Python)
EPW_STATION_CATALOG_URL=

# cad-3d (Next.js)
CESIUM_ION_TOKEN=
NEXT_PUBLIC_RHINO_COMPUTE_URL=http://localhost:6500
COMPUTE_URL=http://localhost:6500
COMPUTE_KEY=shadela-local
COMPUTE_APPSERVER_URL=http://localhost:6501

# Optional export tuning
EXPORT_API_BASE=http://localhost:3000
TERRAIN_Z_EXAGGERATION=5
BUILDINGS_Z_EXAGGERATION=1
BUILDINGS_Z_OFFSET=0
BUILDINGS_CLEARANCE_FT=0.5
TERRAIN_MAX_HEIGHT=
TERRAIN_SCALE_FEET=1.5
DEM_VERTICAL_SCALE=1
HORIZONTAL_SCALE_Y=1

After editing .env, restart dev servers.

============================================================
4) Install dependencies
============================================================

From ShadeLA/:

A) UI dependencies
- Run:
  npm install

B) cad-3d dependencies
- Run:
  npm --prefix cad-3d install

C) Python API dependencies
- Create venv (example):
  python -m venv server/.venv
- Install:
  server/.venv/Scripts/pip install -r server/requirements.txt

============================================================
5) Run locally (development)
============================================================

Option 1: Run everything
- Command (from ShadeLA/):
  npm run dev:full

This starts:
- UI (Vite)
- API (FastAPI)
- CAD (Next)
- Compute (dotnet)

Option 2: UI + Solar API only
- Command:
  npm run dev:solar

Option 3: UI only
- Command:
  npm run dev

============================================================
6) Common issues
============================================================

A) CAD fails to start with "Cannot find package 'dotenv'"
- Fix:
  npm --prefix cad-3d install

B) Blank CAD frame / http://localhost:3001 not reachable
- CAD process likely crashed. Check terminal output.

C) Solar analysis cannot reach backend
- Error message may mention http://127.0.0.1:8000 or 8001.
- Ensure API is running on the configured port.
- Ensure VITE_ANALYSIS_API_BASE_URL matches.

D) Terrain generation fails: Missing OpenTopography key
- Set VITE_OPENTOPO_API_KEY in ShadeLA/.env

E) Power BI console CORS/CSP errors inside app.powerbi.com
- Usually internal Power BI requests; not fixable from this repo.

============================================================
7) Build (production)
============================================================

A) UI build
- From ShadeLA/:
  npm run build

Output is typically in ShadeLA/dist (Vite default).

B) cad-3d build
- From ShadeLA/:
  npm --prefix cad-3d run build

C) Python API
- Run with a production server (example uvicorn/gunicorn) and set env vars.

============================================================
8) Deployment notes
============================================================

This repo is multi-service. Typical deployment options:

Option A: Deploy UI as static site + deploy API separately
- Deploy ShadeLA/dist to a static host (Netlify/Vercel/static hosting).
- Deploy Python API separately (VM, container, or a PaaS) and set:
  VITE_ANALYSIS_API_BASE_URL to the API public URL.

Option B: Deploy UI + API behind one reverse proxy
- Serve Vite build from a web server.
- Reverse-proxy /analysis requests to the Python API.

Option C: CAD/Compute
- cad-3d and rhino.compute are typically internal tools; deploy only if required.

============================================================
9) Ports quick reference
============================================================

- UI (Vite):            5173
- Solar API (FastAPI):  8001
- CAD (Next):           3001
- Rhino Compute:        6500

