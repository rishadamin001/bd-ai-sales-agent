import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRemoteD1, parseWranglerTarget } from "./check-cloudflare-target.mjs";

const MIS_IDS = ["mis-digital-firm", "mis-business-driven", "mis-today", "mis-m-baltzan"];

export function checkMISCatalog(queryResult) {
  const responses = Array.isArray(queryResult) ? queryResult : [queryResult];
  const rows = responses.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
  const got = new Set(rows.map((entry) => entry.id));
  if (MIS_IDS.some((id) => !got.has(id))) {
    throw Error("D1 does not contain all four expected MIS demo titles.");
  }
  return got.size;
}

export function runWrangler(args) {
  const r = spawnSync(process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0)
    throw Error("Wrangler D1 inspection failed. Check account access, token permissions and database.");
  try { return JSON.parse(r.stdout); }
  catch { throw Error("Wrangler did not return valid JSON; database validation stopped."); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const target = parseWranglerTarget(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    const list = runWrangler(["d1", "list", "--json"]);
    checkRemoteD1(target, list);
    console.log("Confirmed the existing Cloudflare D1 database name and immutable ID.");
    if (process.argv.includes("--verify-mis")) {
      const query = runWrangler(["d1","execute",target.database,"--remote",
        "--command=SELECT id FROM products WHERE category='Management Information Systems' ORDER BY id",
        "--json"]);
      checkMISCatalog(query);
      console.log("Confirmed all four MIS demo books in the existing remote D1 database.");
    }
  } catch(error) {
    console.error("Remote D1 verification blocked: " + error.message);
    process.exitCode = 1;
  }
}
