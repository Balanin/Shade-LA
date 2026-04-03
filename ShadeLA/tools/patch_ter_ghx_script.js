import fs from "node:fs";

const GHX_PATH = "D:/meryShadeLa/ShadeLA/public/gh/ter.ghx";

const START_TAG = '<item name="Text" type_name="gh_string" type_code="10">';
const END_TAG = "</item>";

// IronPython2 script: builds a Rhino mesh from W, H, cellSize, heights and outputs it as `out`.
// NOTE: output param name in ter.ghx is "out" (nickname: terrain)
const SCRIPT_LINES = [
  "import Rhino.Geometry as rg",
  "",
  "def _to_int(v, d=0):",
  "    try:",
  "        return int(v)",
  "    except Exception:",
  "        return d",
  "",
  "def _to_float(v, d=0.0):",
  "    try:",
  "        return float(v)",
  "    except Exception:",
  "        return d",
  "",
  "Wv = _to_int(W, 0)",
  "Hv = _to_int(H, 0)",
  "cs = _to_float(cellSize, 1.0)",
  "",
  "out = None",
  "",
  "if Wv >= 2 and Hv >= 2 and heights is not None:",
  "    hs = list(heights)",
  "    if len(hs) == Wv * Hv:",
  "        m = rg.Mesh()",
  "",
  "        for j in range(Hv):",
  "            for i in range(Wv):",
  "                z = _to_float(hs[j * Wv + i], 0.0)",
  "                m.Vertices.Add(i * cs, j * cs, z)",
  "",
  "        for j in range(Hv - 1):",
  "            for i in range(Wv - 1):",
  "                a = j * Wv + i",
  "                b = a + 1",
  "                d = a + Wv",
  "                c = d + 1",
  "                m.Faces.AddFace(a, b, c, d)",
  "",
  "        m.Normals.ComputeNormals()",
  "        m.Compact()",
  "        out = m",
];

const SCRIPT_BASE64 = Buffer.from(SCRIPT_LINES.join("\n"), "utf8").toString("base64");

function main() {
  const text = fs.readFileSync(GHX_PATH, "utf8");

  const start = text.indexOf(START_TAG);
  if (start < 0) {
    throw new Error(`START_TAG not found in ${GHX_PATH}`);
  }

  const contentStart = start + START_TAG.length;
  const end = text.indexOf(END_TAG, contentStart);
  if (end < 0) {
    throw new Error(`END_TAG not found after START_TAG in ${GHX_PATH}`);
  }

  const before = text.slice(0, contentStart);
  const after = text.slice(end);

  const updated = before + SCRIPT_BASE64 + after;
  fs.writeFileSync(GHX_PATH, updated, "utf8");

  console.log("OK: patched ter.ghx script base64");
}

try {
  main();
} catch (e) {
  console.error("FAILED:", e?.message ?? String(e));
  process.exitCode = 1;
}
