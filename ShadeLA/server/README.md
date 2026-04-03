# Solar analysis backend

This folder contains the Python FastAPI backend used by the ShadeLA `Solar -> Run` button.

## Setup (Windows)

1) Create and activate a venv

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2) Install dependencies

```powershell
pip install -r requirements.txt
```

## Run

From the `ShadeLA` repo root:

```powershell
python -m uvicorn server.app:app --host 127.0.0.1 --port 8001
```

Or run UI + API together:

```powershell
npm run dev:solar
```

This starts the API on `http://127.0.0.1:8001` and the UI with `VITE_ANALYSIS_API_BASE_URL` pointing to that port.

Health check:

- http://127.0.0.1:8001/health

## Notes

- The frontend can be configured via `VITE_ANALYSIS_API_BASE_URL` (defaults to `http://127.0.0.1:8000`).
- If something else is already using port `8000`, use `8001` (the default for `npm run dev:solar`).
- EPW station lookup is optional. If you want climate-based mode, set `EPW_STATION_CATALOG_URL` or add `server/cache/epw_stations.json`.
