export type ParsedGrasshopperResult = {
  ready: boolean;
  status: string;
  meshItems: any[];
  meta: Record<string, unknown> | null;
};

type SchemaTree = {
  ParamName?: unknown;
  InnerTree?: unknown;
  innerTree?: unknown;
};

type Schema = {
  values?: unknown;
};

function asArray<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function getInnerTree(tree: any): any {
  return tree?.InnerTree ?? tree?.innerTree ?? null;
}

function findTree(values: any[], name: string): any | null {
  for (const v of values) {
    if (String(v?.ParamName ?? "") === name) return v;
  }
  return null;
}

export function parseBooleanOutput(tree: unknown): boolean {
  const t: any = tree;
  const inner = getInnerTree(t);
  if (!inner || typeof inner !== "object") return false;

  const keys = Object.keys(inner);
  if (!keys.length) return false;

  const firstBranch = (inner as any)[keys[0]];
  const firstItem = Array.isArray(firstBranch) && firstBranch.length ? firstBranch[0] : null;
  if (!firstItem) return false;

  const raw = firstItem?.data ?? firstItem?.Data;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;

  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "0" || s === "no" || s === "n" || s === "") return false;

  return false;
}

export function parseStringOutput(tree: unknown): string {
  const t: any = tree;
  const inner = getInnerTree(t);
  if (!inner || typeof inner !== "object") return "";

  const keys = Object.keys(inner);
  if (!keys.length) return "";

  const firstBranch = (inner as any)[keys[0]];
  const firstItem = Array.isArray(firstBranch) && firstBranch.length ? firstBranch[0] : null;
  if (!firstItem) return "";

  const raw = firstItem?.data ?? firstItem?.Data;
  if (raw == null) return "";

  let s = String(raw);
  s = s.trim();

  try {
    if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
      const unq = JSON.parse(s);
      if (typeof unq === "string") s = unq;
    }
  } catch {
    // ignore
  }

  return s;
}

export function parseMetaOutput(tree: unknown): Record<string, unknown> | null {
  const s = parseStringOutput(tree);
  if (!s) return null;

  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object") return obj as Record<string, unknown>;
    return null;
  } catch {
    return { raw: s };
  }
}

export function extractRhOutMeshItems(values: unknown): any[] {
  const arr = asArray<SchemaTree>(values);
  const rhOut = findTree(arr as any[], "RH_OUT");
  if (!rhOut) return [];

  const inner = getInnerTree(rhOut);
  if (!inner || typeof inner !== "object") return [];

  const out: any[] = [];
  for (const k of Object.keys(inner)) {
    const items = (inner as any)[k];
    if (!Array.isArray(items)) continue;
    for (const it of items) out.push(it);
  }
  return out;
}

export function parseGrasshopperOutputs(schema: Schema | null | undefined): ParsedGrasshopperResult {
  const values = asArray<SchemaTree>((schema as any)?.values);

  const readyTree = findTree(values as any[], "RH_READY");
  const statusTree = findTree(values as any[], "RH_STATUS");
  const metaTree = findTree(values as any[], "RH_META");

  const meshItems = extractRhOutMeshItems((schema as any)?.values);

  const ready = readyTree ? parseBooleanOutput(readyTree) : meshItems.length > 0;
  const status = statusTree ? parseStringOutput(statusTree) : ready ? "ready" : "idle";
  const meta = metaTree ? parseMetaOutput(metaTree) : null;

  return {
    ready,
    status,
    meshItems,
    meta,
  };
}
