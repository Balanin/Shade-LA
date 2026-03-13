import { NextRequest, NextResponse } from "next/server";

type GhParams = {
  x: number;
  h: number;
  z: number;
  edge: number;
  lineStrength: number;
  lineFactor: number;
  load: number;
  reset: boolean;
  run: boolean;
  cr: Array<{ type: string; data: string }>;
  updatedAt: number;
};

function applyDefaults(s: GhParams) {
  s.x = 5;
  s.h = 10;
  s.z = 2;
  s.edge = 0.01;
  s.lineStrength = 8;
  s.lineFactor = 0.5;
  s.load = 1.0;
  s.cr = [];
  s.updatedAt = Date.now();
}

function withCors(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  return res;
}

function getStore(): GhParams {
  const g = globalThis as any;
  if (!g.__ghParams) {
    g.__ghParams = {
      x: 5,
      h: 10,
      z: 2,
      edge: 0.01,
      lineStrength: 8,
      lineFactor: 0.5,
      load: 1.0,
      reset: false,
      run: true,
      cr: [],
      updatedAt: Date.now(),
    } satisfies GhParams;
  }
  return g.__ghParams as GhParams;
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function coerceBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.toLowerCase() === "true") return true;
    if (v.toLowerCase() === "false") return false;
  }
  return null;
}

function coerceCurves(v: unknown): Array<{ type: string; data: string }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ type: string; data: string }> = [];
  for (const it of v) {
    const type = (it as any)?.type;
    const data = (it as any)?.data;
    if (typeof type !== "string" || typeof data !== "string") continue;
    out.push({ type, data });
  }
  return out;
}

export async function GET(_req: NextRequest) {
  const s = getStore();
  const payload = {
    x: s.x,
    h: s.h,
    z: s.z,
    edge: s.edge,
    lineStrength: s.lineStrength,
    lineFactor: s.lineFactor,
    load: s.load,
    reset: s.reset,
    run: s.run,
    cr: s.cr,
    updatedAt: s.updatedAt,
  };

  // Treat reset as a one-time signal (pulse). If something reads reset=true,
  // clear it immediately so it won't keep resetting on every subsequent GET.
  if (s.reset === true) {
    s.reset = false;
    s.updatedAt = Date.now();
  }

  return withCors(NextResponse.json(payload));
}

export async function OPTIONS(_req: NextRequest) {
  return withCors(new NextResponse(null, { status: 204 }));
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return withCors(NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }));
  }

  const x = coerceNumber(body?.x);
  const h = coerceNumber(body?.h);
  const z = coerceNumber(body?.z);

  const edge = coerceNumber(body?.edge);
  const lineStrength = coerceNumber(body?.lineStrength);
  const lineFactor = coerceNumber(body?.lineFactor);
  const load = coerceNumber(body?.load);
  const reset = coerceBoolean(body?.reset);
  const run = coerceBoolean(body?.run);
  const cr = coerceCurves(body?.cr);

  const s = getStore();
  if (reset === true) {
    applyDefaults(s);

    // Preserve explicit reset/run semantics from the caller.
    // Reset should be able to signal Grasshopper to clear sticky state without forcing a run.
    s.reset = true;
    s.run = run === null ? false : run;
    s.cr = [];

    return withCors(
      NextResponse.json({
        ok: true,
        x: s.x,
        h: s.h,
        z: s.z,
        edge: s.edge,
        lineStrength: s.lineStrength,
        lineFactor: s.lineFactor,
        load: s.load,
        reset: s.reset,
        run: s.run,
        cr: s.cr,
        updatedAt: s.updatedAt,
      })
    );
  }
  if (x !== null) s.x = x;
  if (h !== null) s.h = h;
  if (z !== null) s.z = z;
  if (edge !== null) s.edge = edge;
  if (lineStrength !== null) s.lineStrength = lineStrength;
  if (lineFactor !== null) s.lineFactor = lineFactor;
  if (load !== null) s.load = load;
  if (reset !== null) s.reset = reset;
  if (run !== null) s.run = run;
  if (cr !== null) s.cr = cr;
  s.updatedAt = Date.now();

  return withCors(
    NextResponse.json({
      ok: true,
      x: s.x,
      h: s.h,
      z: s.z,
      edge: s.edge,
      lineStrength: s.lineStrength,
      lineFactor: s.lineFactor,
      load: s.load,
      reset: s.reset,
      run: s.run,
      cr: s.cr,
      updatedAt: s.updatedAt,
    })
  );
}
