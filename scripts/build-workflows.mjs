// Writes workflows/*.json from src/workflows/pipeline.mjs. --check fails if the committed JSON is stale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allWorkflows } from "../src/workflows/pipeline.mjs";
import { stableStringify } from "../src/lib/wfkit.mjs";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../workflows");
const check = process.argv.includes("--check");
let stale = 0;
for (const [file, flow] of Object.entries(allWorkflows())) {
  const json = stableStringify(flow.toJSON());
  const target = path.join(OUT, file);
  if (check) {
    const cur = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (cur !== json) { console.error(`stale: workflows/${file}`); stale++; }
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(target, json);
    console.log(`wrote workflows/${file} (${flow.nodes.length} nodes)`);
  }
}
if (stale) { console.error("run npm run build:workflows"); process.exit(1); }
