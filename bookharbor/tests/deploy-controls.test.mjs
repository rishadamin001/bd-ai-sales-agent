import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import {
  parseWranglerTarget, verifyTarget, checkRemoteD1,
} from "../scripts/check-cloudflare-target.mjs";
import { checkMISCatalog } from "../scripts/check-remote-d1.mjs";
import {
  verifyPublicCatalog, checkPublicDeployment, expectedMISIds,
} from "../scripts/check-public-deployment.mjs";
import { all } from "../src/service.mjs";

const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const target = parseWranglerTarget(config);

test("deployment configuration safely parses this project's JSONC", () => {
  assert.equal(target.worker, "bookharbor-mis465");
  assert.equal(target.database, "bookharbor-mis465");
  assert.equal(target.databaseId, "8119e851-bf71-49f8-affd-de2df831c5fc");
  assert.equal(target.account, "bfd0afa1d5021b7538f589b10180d31a");
  const withComments = '{ // comment\n "name":"test", /* block */ "account_id":"bfd0afa1d5021b7538f589b10180d31a", "d1_databases":[{"binding":"DB","database_name":"db","database_id":"8119e851-bf71-49f8-affd-de2df831c5fc",}], }';
  assert.equal(parseWranglerTarget(withComments).worker, "test");
  assert.throws(() => parseWranglerTarget("{ bad }"));
  assert.throws(() => parseWranglerTarget('{"name":"test","d1_databases":[]}'));
});

test("only approved main and exact Cloudflare account/Worker/DB can deploy", () => {
  const good = {
    GITHUB_REF: "refs/heads/main",
    DEPLOY_WORKER_NAME: target.worker,
    DEPLOY_DATABASE_NAME: target.database,
    CLOUDFLARE_ACCOUNT_ID: target.account,
    CLOUDFLARE_API_TOKEN: "FAKE_TEST_TOKEN_NOT_REAL",
  };
  assert.equal(verifyTarget(target, good), true);
  for (const patch of [
    { GITHUB_REF: "refs/heads/feat/test" },
    { DEPLOY_WORKER_NAME: "unrelated-worker" },
    { DEPLOY_DATABASE_NAME: "unrelated-db" },
    { CLOUDFLARE_ACCOUNT_ID: "wrong-account" },
    { CLOUDFLARE_API_TOKEN: "" },
  ]) {
    assert.throws(() => verifyTarget(target, { ...good, ...patch }));
  }
});

test("database identity and MIS records must be confirmed before release", () => {
  const list = [{ name: target.database, uuid: target.databaseId }];
  assert.equal(checkRemoteD1(target, list), true);
  assert.throws(() => checkRemoteD1(target, [{name:target.database,uuid:"wrong"}]));
  assert.throws(() => checkRemoteD1(target, [{name:"other",uuid:target.databaseId}]));
  assert.throws(() => checkRemoteD1(target, {unexpected:"shape"}));
  assert.equal(checkMISCatalog([{results:expectedMISIds.map(id=>({id}))}]), 4);
  assert.throws(() => checkMISCatalog([{results:expectedMISIds.slice(1).map(id=>({id}))}]));
});

test("live catalogue checks use D1 product rules, not fixed stock counts", async () => {
  const db = database();
  db.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  const products = await all(db, "SELECT * FROM products ORDER BY rowid");
  db.close();
  assert.deepEqual(verifyPublicCatalog({ok:true,demo:true}, products), {total:12,mis:4});
  products.find(p => p.id === "hobbit").stock = 0; // Real orders can change stock.
  assert.equal(verifyPublicCatalog({ok:true,demo:true}, products).total, 12);
  assert.throws(() => verifyPublicCatalog({ok:false,demo:true}, products));
  assert.throws(() => verifyPublicCatalog({ok:true,demo:true}, products.filter(p=>p.id!=="mis-today")));
  assert.throws(() => verifyPublicCatalog({ok:true,demo:true}, [...products, products[0]]));
  const fakeFetch = async (url) => new Response(JSON.stringify(
    String(url).endsWith("api/health") ? {ok:true,demo:true} : products,
  ), {status:200,headers:{"Content-Type":"application/json"}});
  const actual = await checkPublicDeployment("https://bookharbor-mis465.example.net/", fakeFetch);
  assert.deepEqual(actual,{total:12,mis:4});
  await assert.rejects(() => checkPublicDeployment("http://bookharbor.invalid/", fakeFetch));
  await assert.rejects(() => checkPublicDeployment("https://bookharbor.invalid/path", fakeFetch));
});

test("manual Cloudflare workflow never runs on push and checks secrets before mutation", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/bookharbor-controlled-deploy.yml", import.meta.url),"utf8");
  assert.match(workflow,/^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow,/^\s+push:/m);
  assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/scripts\/check-cloudflare-target\.mjs/);
  assert.match(workflow,/scripts\/check-remote-d1\.mjs/);
  assert.match(workflow,/migrations\/2026-10-27-add-mis-books\.sql/);
  assert.match(workflow,/scripts\/check-public-deployment\.mjs/);
  assert.match(workflow,/secrets\.CLOUDFLARE_API_TOKEN/);
  const a = workflow.indexOf("node scripts/check-cloudflare-target.mjs");
  const b = workflow.indexOf("--file=migrations/2026-10-27-add-mis-books.sql");
  assert.ok(a >= 0 && b > a);
  assert.doesNotMatch(workflow,/\bwrangler d1 (?:create|delete)\b/);
});
