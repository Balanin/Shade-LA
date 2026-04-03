from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.api.direct_sun_hours import router as direct_sun_hours_router
from server.api.epw import router as epw_router


app = FastAPI(title="Terrain Solar Analysis API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
        "http://127.0.0.1:5175",
        "http://localhost:5175",
        "http://127.0.0.1:5176",
        "http://localhost:5176",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(epw_router)
app.include_router(direct_sun_hours_router)
app.include_router(epw_router, prefix="/analysis-api")
app.include_router(direct_sun_hours_router, prefix="/analysis-api")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/analysis-api/health")
def analysis_api_health():
    return {"ok": True}
