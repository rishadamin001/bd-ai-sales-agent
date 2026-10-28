import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database } from "../scripts/db.mjs";
import { all, classify } from "../src/service.mjs";
import { transition } from "../src/engine.mjs";
import { languagePreference, wantsOneRecommendation } from "../src/conversation.mjs";
import { geminiEligible, classifyWithGemini, parseGeminiClassification } from "../src/gemini.mjs";

const db = database();
db.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
const products = await all(db, "SELECT * FROM products ORDER BY rowid");
db.close();

test("language-switch commands take priority and persist across unrelated messages", async () => {
  assert.equal(languagePreference("Switch to English"), "en");
  assert.equal(languagePreference("Can you speak in english from now?"), "en");
  assert.equal(languagePreference("Accha Banglay bolo"), "bn");
  assert.equal(languagePreference("বাংলায় বলুন"), "bn");
  assert.equal(languagePreference("Switch to Banglish"), "bl");
  assert.equal(languagePreference("Auto language"), "auto");

  let r = await transition({ step:"browse", language:"bl" }, "Switch to English", products);
  assert.equal(r.state.language, "en");
  assert.equal(r.state.languageLock, "en");
  assert.match(r.reply, /reply in English from now/);
  r = await transition(r.state, "Hobbit dam koto?", products);
  assert.equal(r.state.language, "en");
  assert.match(r.reply, /Price: ৳650/);
  r = await transition(r.state, "reset", products);
  assert.equal(r.state.languageLock, "en");
  r = await transition(r.state, "Can you speak in english from now?", products);
  assert.equal(r.state.language, "en");
  r = await transition(r.state, "Accha Banglay bolo", products);
  assert.equal(r.state.language, "bn");
  assert.match(r.reply, /বাংলায় উত্তর দেব/);
  r = await transition(r.state, "Hobbit price koto?", products);
  assert.equal(r.state.language, "bn");
  assert.match(r.reply, /দাম ৳650/);
  r = await transition(r.state, "Auto language", products);
  assert.equal(r.state.languageLock, undefined);
  r = await transition(r.state, "Hobbit dam koto?", products);
  assert.equal(r.state.language, "bl");
  assert.match(r.reply, /Dam ৳650/);
});

test("explicit language switches never confirm or alter a draft order", async () => {
  const original = { step:"confirm", language:"bl", product:"hobbit", quantity:2,
    wrap:"none", zone:"dhaka", name:"Demo Reader", phone:"01700000000",
    address:"House 1 Road 2 Mirpur Dhaka", pending:{subtotal:1300,delivery:70,total:1370} };
  const r = await transition(original, "Switch to English", products);
  assert.equal(r.state.step, "confirm");
  assert.equal(r.state.languageLock, "en");
  assert.equal(r.state.quantity, 2);
  assert.deepEqual(r.state.pending, original.pending);
  assert.equal(r.order, undefined);
  const next = await transition(r.state, "confirm", products);
  assert.equal(next.order.total, 1370);
  assert.equal(next.state.language, "en");
});

test("human handoff remains silent even for language requests", async () => {
  const r = await transition({step:"browse",handoff:true,language:"bl"}, "Switch to English", products);
  assert.equal(r.silent,true);
  assert.equal(r.order,undefined);
});

test("one recommendation selects exactly one in-stock book and remembers it", async () => {
  for (const q of ["Recommend me one", "Suggest me one book", "Recommend one fantasy book"]) {
    assert.equal(wantsOneRecommendation(q), true);
    const r = await transition(null,q,products,() => { throw Error("AI unnecessary"); });
    assert.equal(r.state.step,"browse");
    assert.equal(r.order,undefined);
    assert.ok(r.state.product);
    assert.equal(r.state.recommendedProduct,r.state.product);
    const p=products.find(x=>x.id===r.state.product);
    assert.ok(p.stock>0);
    assert.match(r.reply, new RegExp(p.title.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.match(r.reply,new RegExp(String(p.price)));
    assert.doesNotMatch(r.reply,/more matching titles|lowest price first/);
    assert.ok(r.reply.length<210);
  }
  assert.equal(wantsOneRecommendation("Do not recommend me one"),false);
});

test("followups use the last real D1 book without inventing plot details", async () => {
  const first = await transition(null,"Recommend me one fantasy book",products);
  assert.equal(first.state.product,"hobbit");
  let r=await transition(first.state,"Who wrote it?",products);
  assert.match(r.reply,/J\.R\.R\. Tolkien/);
  assert.equal(r.order,undefined);
  r=await transition(r.state,"Why should I read it?",products);
  assert.match(r.reply,/fantasy title/);
  assert.match(r.reply,/৳650/);
  assert.doesNotMatch(r.reply,/bestseller|award winning|discount/);
  const cost=await transition(r.state,"How much is it?",products);
  assert.match(cost.reply,/৳650/);
  assert.equal(cost.state.product,"hobbit");
});

test("new Gemini provider is off unless key and explicit flag are present", async () => {
  const called=()=> {throw Error("Network must not be used");};
  assert.equal(await classifyWithGemini({GEMINI_ENABLED:"false",GEMINI_API_KEY:"secret"}, "Tell me about Bilbo", products,{},called),null);
  assert.equal(await classifyWithGemini({GEMINI_ENABLED:"true"}, "Tell me about Bilbo", products,{},called),null);
});

test("Gemini is never sent private checkout details", async () => {
  for(const q of ["My number is 01712345678","House 12 Road 2 Mirpur Dhaka",
    "My email is test@example.com","Confirm order please","OTP 123456",
    "What is the address for my order?","Checkout", "01700000000"]) {
    assert.equal(geminiEligible(q),false,q);
  }
  assert.equal(geminiEligible("Do you have the adventure about Bilbo?"),true);
  assert.equal(geminiEligible("Who is the author of this book?"),true);
});

test("Gemini JSON parser validates product IDs, disallows prices and rejects bad responses",() => {
  const response=(obj)=>({candidates:[{content:{parts:[{text:JSON.stringify(obj)}]}}]});
  assert.deepEqual(parseGeminiClassification(response({intent:"product",product_id:"hobbit"}),products),
    {intent:"product",product_id:"hobbit",provider:"gemini"});
  assert.deepEqual(parseGeminiClassification(response({intent:"product",product_id:"fake",price:1,order:true}),products),
    {intent:"unknown",product_id:null,provider:"gemini"});
  assert.equal(parseGeminiClassification(response({intent:"smalltalk",reply:"Buy now for ৳1"}),products),null);
  assert.equal(parseGeminiClassification(response({intent:"smalltalk",reply:"Hello! What are you reading lately?"}),products).reply,
    "Hello! What are you reading lately?");
  assert.equal(parseGeminiClassification({candidates:[{content:{parts:[{text:"not JSON"}]}}]},products),null);
});

test("Gemini REST call is bounded, uses private auth header, and sends catalogue not customer PII",async()=>{
  let payload;
  const mockFetch=async (url,options)=>{
    assert.equal(new URL(url).hostname,"generativelanguage.googleapis.com");
    assert.ok(url.endsWith("/gemini-3.5-flash-lite:generateContent"));
    assert.equal(options.headers["x-goog-api-key"],"test_private_key_not_real");
    assert.equal(options.method,"POST");
    payload=JSON.parse(options.body);
    return new Response(JSON.stringify({candidates:[{content:{parts:[{
      text:JSON.stringify({intent:"product",product_id:"hobbit"})
    }]}}]}),{status:200,headers:{"Content-Type":"application/json"}});
  };
  const env={GEMINI_ENABLED:"true",GEMINI_API_KEY:"test_private_key_not_real"};
  const r=await classifyWithGemini(env,"Do you have the adventure about Bilbo?",products,
    {language:"en",product:"hobbit"},mockFetch);
  assert.equal(r.intent,"product");
  assert.equal(r.product_id,"hobbit");
  assert.equal(r.provider,"gemini");
  assert.equal(payload.generationConfig.responseMimeType,"application/json");
  assert.match(JSON.stringify(payload),/managing the digital firm/i);
  assert.doesNotMatch(JSON.stringify(payload),/test_private_key_not_real/);
  await assert.rejects(classifyWithGemini(env,"Tell me about Bilbo",products,{},async()=>new Response("quota",{status:429})));
});

test("fallback remains functional if Gemini is unavailable",async()=>{
  // No key means no Google request, and existing Workers AI continues.
  const result=await classify({
    GEMINI_ENABLED:"true", AI_ENABLED:"true", AI_MODEL:"test",
    AI:{run:async()=>({response:{intent:"product",product_id:"hobbit"}})}
  },"Bilbo adventure",products);
  assert.deepEqual(result,{intent:"product",product_id:"hobbit"});
});

test("trusted smalltalk can be returned; AI cannot place orders",async()=>{
  const r=await transition(null,"How's your day?",products,async()=>({
    intent:"smalltalk",product_id:null,reply:"Doing well! What kind of book are you looking for?",provider:"gemini",
  }));
  assert.match(r.reply,/Doing well/);
  assert.equal(r.engine,"gemini");
  assert.equal(r.order,undefined);
  const rec=await transition(null,"Recommend me one",products,async()=>({
    intent:"order",product_id:"hobbit",order:true,
  }));
  assert.equal(rec.order,undefined);
  assert.equal(rec.state.step,"browse");
});
