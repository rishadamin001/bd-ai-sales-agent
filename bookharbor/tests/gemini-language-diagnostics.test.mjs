import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import { all } from "../src/service.mjs";
import { transition } from "../src/engine.mjs";
import { languagePreference } from "../src/conversation.mjs";
import { classifyWithGemini } from "../src/gemini.mjs";

const db = database();
db.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
const products = await all(db, "SELECT * FROM products");
db.close();

test("the Bengali-to-English switch from the Messenger screenshot is understood", async () => {
  for (const input of [
    "ইংরেজিতে সুইচ করো",
    "ইংরেজিতে কথা বলো",
    "ইংরেজিতে উত্তর দিন",
    "এখন থেকে ইংরেজিতে সুইচ করুন",
    "ইংলিশে বলো",
    "English e switch koro",
    "English e bolo",
    "ingrejite switch koro",
  ]) {
    assert.equal(languagePreference(input), "en", input);
    const r = await transition(
      { step:"browse", language:"bn", languageLock:"bn" },
      input, products, () => { throw Error("An explicit language command must not call AI"); },
    );
    assert.equal(r.state.language, "en", input);
    assert.equal(r.state.languageLock, "en", input);
    assert.match(r.reply, /^Sure! I'll reply in English/);
    assert.equal(r.order, undefined);
    assert.equal(r.engine, "rules");
    const next = await transition(r.state, "Is there any discount on books?", products);
    assert.match(next.reply, /^No discounts are currently listed/);
    assert.equal(next.state.language, "en");
  }
});

test("language switches to Bengali remain supported without accidental matches", async () => {
  for (const text of ["বাংলায় সুইচ করো", "বাংলায় পরিবর্তন করুন", "Accha Banglay bolo"]) {
    assert.equal(languagePreference(text), "bn");
    const r = await transition({ step:"browse", language:"en", languageLock:"en" }, text, products);
    assert.equal(r.state.language, "bn");
    assert.match(r.reply,/বাংলায় উত্তর দেব/);
  }
  for (const text of ["ইংরেজি বই আছে?", "English grammar books", "English textbooks", "ইংলিশ বই দেখাও"]) {
    assert.equal(languagePreference(text), null, text);
  }
});

test("language changes during review are harmless and preserve confirmation safeguards", async () => {
  const previous = {
    step:"confirm",language:"bn",languageLock:"bn",product:"hobbit",
    quantity:2,wrap:"none",zone:"dhaka",name:"Demo Reader",
    phone:"01700000000",address:"House 1 Road 2 Mirpur Dhaka",
    pending:{subtotal:1300,delivery:70,total:1370},
  };
  const r = await transition(previous,"ইংরেজিতে সুইচ করো",products);
  assert.equal(r.state.step,"confirm");
  assert.equal(r.state.languageLock,"en");
  assert.deepEqual(r.state.pending,previous.pending);
  assert.equal(r.order,undefined);
  const c = await transition(r.state,"CONFIRM",products);
  assert.equal(c.order.total,1370);
});

test("dashboard Gemini activation survives later Wrangler deployments", async () => {
  const cfg = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"keep_vars"\s*:\s*true/);
  assert.doesNotMatch(cfg, /"GEMINI_API_KEY"\s*:/);
});

test("Gemini logs only safe attempt/result markers, never the key or message text", async () => {
  const records = [];
  const info = console.info;
  const warn = console.warn;
  console.info = (message) => records.push(message);
  console.warn = (message) => records.push(message);
  try {
    const env = {GEMINI_ENABLED:"true",GEMINI_API_KEY:"private_test_key_x123",GEMINI_MODEL:"gemini-3.5-flash-lite"};
    const successful = async () => new Response(JSON.stringify({
      candidates:[{content:{parts:[{text:JSON.stringify({
        intent:"product", product_id:"hobbit",
      })}]}}],
    }),{status:200});
    const result = await classifyWithGemini(env,
      "Do you have the adventure about Bilbo?",products,{},successful);
    assert.equal(result.provider,"gemini");
    assert.deepEqual(records.map(s=>JSON.parse(s).stage),["attempt","classified"]);
    records.length=0;
    await assert.rejects(classifyWithGemini(env,
      "Do you have the adventure about Bilbo?",products,{},async()=>
        new Response("",{status:429})));
    assert.deepEqual(records.map(s=>JSON.parse(s).stage),["attempt","http_error"]);
    assert.equal(JSON.parse(records[1]).status,429);
    assert.doesNotMatch(records.join(" " ),/private_test_key|adventure about Bilbo|01700000000/);
    records.length=0;
    const skipped=await classifyWithGemini(env,"My number is 01700000000",
      products,{},async()=>{throw Error("Must not send private data");});
    assert.equal(skipped,null);
    assert.equal(records.length,0);
  } finally {
    console.info=info;
    console.warn=warn;
  }
});
