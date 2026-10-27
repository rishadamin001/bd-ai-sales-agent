import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* Only the configured existing Worker and D1 DB are valid deployment targets.
   No account creation, secret output, or database reset is permitted. */
export function parseWranglerTarget(source) {
  // Support the current JSONC format (comments and trailing commas) without
  // executing or evaluating configuration as JavaScript.
  let clean = "", mode = "plain", escape = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (mode === "line") {
      if (c === "\n") { clean += c; mode = "plain"; }
    } else if (mode === "block") {
      if (c === "*" && n === "/") { i++; mode = "plain"; }
    } else if (mode === "string") {
      clean += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') mode = "plain";
    } else if (c === '"') {
      clean += c; mode = "string";
    } else if (c === "/" && n === "/") {
      i++; mode = "line";
    } else if (c === "/" && n === "*") {
      i++; mode = "block";
    } else {
      clean += c;
    }
  }
  if (mode === "string" || mode === "block") throw Error("Malformed Wrangler JSONC.");
  // Wrangler JSONC currently has no comma-adjacent bracket values.
  clean = clean.replace(/,\s*([}\]])/g, "$1");
  const cfg = JSON.parse(clean);
  const dbs = cfg.d1_databases || [];
  if (typeof cfg.name !== "string" || typeof cfg.account_id !== "string" ||
      !/^[0-9a-f]{32}$/.test(cfg.account_id) || dbs.length !== 1 ||
      dbs[0].binding !== "DB" || typeof dbs[0].database_name !== "string" ||
      !/^[0-9a-f-]{36}$/.test(dbs[0].database_id || "")) {
    throw Error("Expected one existing Worker, account ID and DB binding in wrangler.jsonc.");
  }
  return {
    worker: cfg.name,
    account: cfg.account_id,
    database: dbs[0].database_name,
    databaseId: dbs[0].database_id,
  };
}

export function verifyTarget(target, env = process.env) {
  if (env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main")
    throw Error("Only the main branch may deploy BookHarbor.");
  if (env.DEPLOY_WORKER_NAME !== target.worker ||
      env.DEPLOY_DATABASE_NAME !== target.database)
    throw Error("Confirmation does not match the existing Worker and D1 database.");
  if (!env.CLOUDFLARE_ACCOUNT_ID ||
      env.CLOUDFLARE_ACCOUNT_ID !== target.account)
    throw Error("The connected Cloudflare account does not match wrangler.jsonc.");
  if (!env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN.length < 10)
    throw Error("Cloudflare API token is missing; save it as a GitHub Actions secret.");
  return true;
}
export function checkRemoteD1(target, list) {
  const databases = Array.isArray(list) ? list :
    Array.isArray(list?.databases) ? list.databases : null;
  if (!databases) throw Error("Could not confirm D1 database list format.");
  if (!databases.some((db) => String(db.name) === target.database &&
      String(db.uuid || db.id || db.database_id) === target.databaseId)) {
    throw Error("Expected D1 database and ID are not present in the Cloudflare account. Deployment stopped.");
  }
  return true;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const target = parseWranglerTarget(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    verifyTarget(target);
    console.log("Existing Worker, D1 binding and account identity verified. No changes made.");
  } catch (error) {
    console.error("Deployment verification blocked: " + error.message);
    process.exitCode = 1;
  }
}
