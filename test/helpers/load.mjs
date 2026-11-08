// Loads the plain-JS function files that are pasted into n8n Code nodes, so they can be unit tested as is.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/code");
export function loadFns(file, names) {
  const src = fs.readFileSync(path.join(CODE, file), "utf8");
  return new Function(`${src}\nreturn { ${names.join(", ")} };`)();
}
