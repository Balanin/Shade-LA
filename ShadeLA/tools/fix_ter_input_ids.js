import fs from "node:fs";

const GHX_PATH = "D:/meryShadeLa/ShadeLA/public/gh/ter.ghx";

// These should be unique per input param. We'll use the actual InstanceGuid values
// from the InputParam blocks in ter.ghx so Grasshopper/Compute can map ParamName -> input.
const NEW_IDS = [
  "a6b4b7ae-b33f-457c-9885-7a7aff184ccc", // W
  "e9afeff9-590c-4801-b363-77e7918c861e", // H
  "7883ff87-b6ff-4821-b659-2f34692703a3", // cellSize
  "ab69f444-1b2f-477d-8b08-ed7f95c5d7ea", // heights
];

function main() {
  const text = fs.readFileSync(GHX_PATH, "utf8");

  // Replace the first 4 occurrences of InputId items in the ParameterData section.
  // They currently all share the same guid and Compute warns about duplicated inputs.
  const re = /(<item name="InputId" index="(\d+)" type_name="gh_guid" type_code="9">)([0-9a-fA-F-]{36})(<\/item>)/g;

  let count = 0;
  const updated = text.replace(re, (all, p1, idx, _idx2, oldGuid, p5) => {
    const i = Number(idx);
    if (!Number.isFinite(i) || i < 0 || i >= NEW_IDS.length) return all;
    count++;
    return p1 + NEW_IDS[i] + p5;
  });

  if (count < 4) {
    throw new Error(`Only replaced ${count} InputId entries; expected at least 4. File format may have changed.`);
  }

  fs.writeFileSync(GHX_PATH, updated, "utf8");
  console.log(`OK: updated ${count} InputId entries in ter.ghx`);
}

try {
  main();
} catch (e) {
  console.error("FAILED:", e?.message ?? String(e));
  process.exitCode = 1;
}
