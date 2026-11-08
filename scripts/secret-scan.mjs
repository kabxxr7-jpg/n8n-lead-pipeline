// Scans every file that would be published (not git-ignored) for keys, the real values in .env,
// personal details and words that must not appear in public text. Exits 1 on any hit.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
let files;
try {
  files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  console.error("run inside the git repository");
  process.exit(2);
}

const patterns = [
  [/re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/, "Resend key"],
  [/AIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/pat-(na|eu|ap)\d?-[0-9a-f-]{20,}/, "HubSpot private app token"],
  [/sk-[A-Za-z0-9_-]{20,}/, "secret key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b(claude|anthropic)\b/i, "assistant tool name"],
  [/co-authored-by/i, "co-author trailer"],
  [new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "home directory path"],
  [/\+?\b91[ -]?\d{5}[ -]?\d{5}\b/, "phone number"],
];
// exact values of every secret in .env (when present)
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^(HUBSPOT_TOKEN|GEMINI_API_KEY|RESEND_API_KEY|TEAM_EMAIL|N8N_ENCRYPTION_KEY)=(.+)$/);
    if (m && m[2].trim().length >= 6) patterns.push([new RegExp(m[2].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `value of ${m[1]}`]);
  }
}
const allow = new Set(["scripts/secret-scan.mjs"]);
let hits = 0;
for (const f of files) {
  if (allow.has(f) || !fs.existsSync(f) || fs.statSync(f).size > 5e6) continue;
  const buf = fs.readFileSync(f);
  if (buf.includes(0) && !/\.(png|jpe?g)$/i.test(f)) continue;
  const text = /\.(png|jpe?g)$/i.test(f) ? buf.toString("latin1") : buf.toString("utf8");
  for (const [re, what] of patterns) {
    if (re.test(text)) {
      console.log(`HIT ${what}: ${f}`);
      hits++;
    }
  }
}
try {
  const log = execFileSync("git", ["log", "--format=%an %ae%n%B"], { encoding: "utf8" });
  for (const [re, what] of patterns) if (re.test(log)) { console.log(`HIT ${what}: commit messages/authors`); hits++; }
} catch {}
console.log(`${files.length} files scanned, ${hits} hit(s)`);
process.exit(hits ? 1 : 0);
